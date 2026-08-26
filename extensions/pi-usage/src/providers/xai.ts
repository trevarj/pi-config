import type { UsageReport, XaiBillingPayload } from "../types.js";

export function normalizeXaiBillingPayload(
	payload: XaiBillingPayload,
	capturedAt: number,
): UsageReport {
	const config = asObject(payload.config);
	const used = asPercent(config?.creditUsagePercent);
	if (used === undefined) {
		throw new Error("xAI billing endpoint returned no displayable usage data.");
	}
	const period = asObject(config?.currentPeriod);
	const resetsAt = asEpochSeconds(period?.end);

	return {
		providerId: "xai",
		providerName: "Grok",
		capturedAt,
		source: "xai-subscription-billing",
		semantics: { kind: "consumer-subscription", label: "Grok subscription credits" },
		buckets: [
			{
				id: "weekly",
				label: "Weekly credit pool",
				used,
				remaining: 100 - used,
				limit: 100,
				unit: "percent",
				...(resetsAt !== undefined ? { resetsAt } : {}),
			},
		],
		metrics: [],
	};
}

function asObject(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
}

function asPercent(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
		return undefined;
	}
	return value;
}

function asEpochSeconds(value: unknown): number | undefined {
	if (typeof value !== "string" || !value.trim()) return undefined;
	const timestamp = Date.parse(value);
	return Number.isNaN(timestamp) ? undefined : Math.floor(timestamp / 1_000);
}
