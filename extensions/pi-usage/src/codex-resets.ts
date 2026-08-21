import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readStoredCredential } from "@earendil-works/pi-coding-agent";
import { fingerprintResolvedAuth, sanitizeDisplayText } from "./core.js";
import {
	AUTH_FINGERPRINT_SALT,
	adapterForProvider,
	fetchProviderJson,
	resolveUsageAuth,
} from "./query.js";
import type { ResolvedUsageAuth, UsageReport } from "./types.js";

const CODEX_RESET_CREDITS_URL = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";
const CODEX_RESET_CONSUME_URL = `${CODEX_RESET_CREDITS_URL}/consume`;
const MAX_RESET_OPTIONS = 32;
const MAX_CREDIT_ID_CHARS = 1_024;

type StoredCredentialReader = (providerId: string) => unknown;

export type CodexResetOutcomeCode = "reset" | "nothing_to_reset" | "no_credit" | "already_redeemed";

export interface CodexResetOption {
	creditId?: string;
	title: string;
	description: string;
	expiresAt?: number;
}

export interface CodexResetAvailability {
	availableCount: number;
	options: CodexResetOption[];
}

export interface CodexResetOutcome {
	code: CodexResetOutcomeCode;
	windowsReset: number;
}

export function codexResetCount(report: UsageReport): number | undefined {
	const value = report.metrics.find((metric) => metric.id === "reset-credits")?.value;
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export function codexResetActionDescription(report: UsageReport): string {
	const count = codexResetCount(report);
	if (count === undefined) return "Check reset availability.";
	if (count === 0) return "No usage limit resets available.";
	return `You have ${count} ${resetLabel(count)} available.`;
}

export function genericCodexResetOption(): CodexResetOption {
	return {
		title: "Full reset",
		description: "Reset your current usage limits.",
	};
}

export function resetOptionExpiration(option: CodexResetOption): string {
	if (option.expiresAt === undefined) return "Does not expire.";
	const expiration = new Date(option.expiresAt * 1_000);
	if (Number.isNaN(expiration.getTime())) return "Expiration unavailable.";
	return `Expires ${expiration.toLocaleString()}.`;
}

export function resetConfirmationLines(option: CodexResetOption | undefined): string[] {
	if (!option) return ["The selected reset is unavailable."];
	return [
		option.title,
		resetOptionExpiration(option),
		option.description,
		"This consumes one earned reset for the current OpenAI Codex account.",
	];
}

export function formatCodexResetOutcome(
	outcome: CodexResetOutcome | undefined,
	remainingCount: number | undefined,
): string {
	const remaining =
		remainingCount === undefined
			? ""
			: ` You have ${remainingCount} ${resetLabel(remainingCount)} left.`;
	if (!outcome) return "You don't have any usage limit resets available.";
	if (outcome.code === "reset") return `Usage reset.${remaining}`.trim();
	if (outcome.code === "already_redeemed") {
		return `Usage reset was already completed.${remaining}`.trim();
	}
	if (outcome.code === "nothing_to_reset") {
		return "Your usage does not need a reset right now.";
	}
	return "No usage limit resets are available.";
}

export function resetLabel(count: number): string {
	return count === 1 ? "usage limit reset" : "usage limit resets";
}

export async function resolveCodexResetAuth(
	ctx: ExtensionContext,
	salt: Uint8Array = AUTH_FINGERPRINT_SALT,
	credentialReader: StoredCredentialReader = readStoredCredential,
): Promise<ResolvedUsageAuth> {
	const model = ctx.model;
	if (model?.provider !== "openai-codex") {
		throw new Error("Usage limit resets require the current model to use OpenAI Codex.");
	}
	const expectedModel = `${model.provider}/${model.id}`;
	const adapter = adapterForProvider("openai-codex");
	if (!adapter) throw new Error("OpenAI Codex usage support is unavailable.");
	const auth = await resolveUsageAuth(ctx, adapter, salt, credentialReader);
	if (`${ctx.model?.provider}/${ctx.model?.id}` !== expectedModel) {
		throw new Error("The current model changed while resolving Codex reset authentication.");
	}
	if (!auth) throw new Error("No runtime credential is configured for OpenAI Codex.");

	const credential = asObject(credentialReader("openai-codex"));
	if (credential?.type !== "oauth") {
		throw new Error(
			"Usage limit resets require the OpenAI Codex OAuth account configured through Pi /login.",
		);
	}
	const storedAccess = asNonemptyString(credential.access);
	const resolvedAccess = bearerToken(headerValue(auth.headers, "Authorization")) ?? auth.apiKey;
	if (!storedAccess || !resolvedAccess) {
		throw new Error("OpenAI Codex OAuth credentials were incomplete.");
	}
	if (storedAccess !== resolvedAccess) {
		throw new Error(
			"The active OpenAI Codex runtime account does not match Pi's stored OAuth account.",
		);
	}
	const accountId = validHeaderValue(credential.accountId);
	if (!accountId)
		throw new Error("The OpenAI Codex OAuth credential did not include a valid account ID.");

	const authorization = `Bearer ${resolvedAccess}`;
	const headers = {
		Authorization: authorization,
		"chatgpt-account-id": accountId,
	};
	return {
		apiKey: resolvedAccess,
		headers,
		fingerprint: fingerprintResolvedAuth({ headers }, salt),
		secrets: [
			...new Set([...auth.secrets, storedAccess, resolvedAccess, authorization, accountId]),
		],
		model: auth.model,
	};
}

export async function listCodexResetCredits(
	auth: ResolvedUsageAuth,
	signal: AbortSignal,
	timeoutMs: number,
): Promise<CodexResetAvailability> {
	const payload = await fetchProviderJson(
		CODEX_RESET_CREDITS_URL,
		auth,
		signal,
		timeoutMs,
		"Codex usage-limit reset endpoint",
	);
	return normalizeCodexResetCreditsPayload(payload);
}

export async function consumeCodexResetCredit(
	auth: ResolvedUsageAuth,
	option: CodexResetOption,
	redeemRequestId: string,
	signal: AbortSignal,
	timeoutMs: number,
): Promise<CodexResetOutcome> {
	if (!redeemRequestId) throw new Error("Codex reset redemption request ID must not be empty.");
	const payload = await fetchProviderJson(
		CODEX_RESET_CONSUME_URL,
		auth,
		signal,
		timeoutMs,
		"Codex usage-limit reset consume endpoint",
		{
			method: "POST",
			body: {
				redeem_request_id: redeemRequestId,
				...(option.creditId ? { credit_id: option.creditId } : {}),
			},
		},
	);
	const code = payload.code;
	if (!isCodexResetOutcomeCode(code)) {
		throw new Error("Codex reset consume endpoint returned an unknown outcome code.");
	}
	const windowsReset =
		payload.windows_reset === undefined ? 0 : nonnegativeInteger(payload.windows_reset);
	if (windowsReset === undefined) {
		throw new Error("Codex reset consume endpoint returned an invalid windows_reset value.");
	}
	return { code, windowsReset };
}

export function normalizeCodexResetCreditsPayload(
	payload: Record<string, unknown>,
): CodexResetAvailability {
	const availableCount = nonnegativeInteger(payload.available_count);
	if (availableCount === undefined) {
		throw new Error("Codex reset credits response returned an invalid available_count.");
	}
	const rawCredits = payload.credits;
	if (rawCredits !== undefined && !Array.isArray(rawCredits)) {
		throw new Error("Codex reset credits response returned invalid credits.");
	}

	const options = (rawCredits ?? [])
		.map(asObject)
		.filter((credit): credit is Record<string, unknown> => Boolean(credit))
		.filter((credit) => credit.status === "available" && credit.reset_type === "codex_rate_limits")
		.map(normalizeResetOption)
		.sort(
			(left, right) =>
				(left.expiresAt ?? Number.MAX_SAFE_INTEGER) - (right.expiresAt ?? Number.MAX_SAFE_INTEGER),
		)
		.slice(0, Math.min(availableCount, MAX_RESET_OPTIONS));

	if (availableCount > 0 && options.length === 0) {
		options.push(genericCodexResetOption());
	}
	return { availableCount, options };
}

function normalizeResetOption(credit: Record<string, unknown>): CodexResetOption {
	const creditId = asOpaqueId(credit.id);
	if (!creditId) throw new Error("Codex reset credits response returned an invalid credit ID.");
	let expiresAt: number | undefined;
	if (credit.expires_at !== undefined && credit.expires_at !== null) {
		if (typeof credit.expires_at !== "string") {
			throw new Error("Codex reset credits response returned an invalid expiration time.");
		}
		const parsed = Date.parse(credit.expires_at);
		if (!Number.isFinite(parsed)) {
			throw new Error("Codex reset credits response returned an invalid expiration time.");
		}
		expiresAt = Math.floor(parsed / 1_000);
	}
	const title = displayString(credit.title) ?? "Full reset";
	const description = displayString(credit.description) ?? "Reset your current usage limits.";
	return {
		creditId,
		title,
		description,
		...(expiresAt === undefined ? {} : { expiresAt }),
	};
}

function isCodexResetOutcomeCode(value: unknown): value is CodexResetOutcomeCode {
	return (
		value === "reset" ||
		value === "nothing_to_reset" ||
		value === "no_credit" ||
		value === "already_redeemed"
	);
}

function asObject(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
}

function asNonemptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asOpaqueId(value: unknown): string | undefined {
	if (typeof value !== "string" || value.length === 0 || value.length > MAX_CREDIT_ID_CHARS) {
		return undefined;
	}
	return value;
}

function displayString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	return sanitizeDisplayText(value, 160) || undefined;
}

function validHeaderValue(value: unknown): string | undefined {
	if (typeof value !== "string" || !value || value.length > 512) return undefined;
	if (/[^\x20-\x7e]/u.test(value)) return undefined;
	return value;
}

function nonnegativeInteger(value: unknown): number | undefined {
	const parsed =
		typeof value === "number"
			? value
			: typeof value === "string" && value.trim()
				? Number(value)
				: Number.NaN;
	if (!Number.isSafeInteger(parsed) || parsed < 0) return undefined;
	return parsed;
}

function bearerToken(authorization: string | undefined): string | undefined {
	return /^Bearer\s+(.+)$/iu.exec(authorization ?? "")?.[1];
}

function headerValue(headers: Record<string, string>, name: string): string | undefined {
	return Object.entries(headers).find(
		([candidate]) => candidate.toLowerCase() === name.toLowerCase(),
	)?.[1];
}
