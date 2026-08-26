import type { GoogleAntigravityPayload, UsageBucket, UsageReport } from "../types.js";

export function normalizeGoogleAntigravityPayload(
	payload: GoogleAntigravityPayload,
	capturedAt: number,
): UsageReport {
	const summary = summaryBuckets(payload);
	const weekly = mostUsed(summary.filter((bucket) => isWeekly(windowName(bucket))));
	const short = mostUsed(summary.filter((bucket) => isShort(windowName(bucket))));
	const selected = [
		...(short ? [toUsageBucket("five-hour", "5-hour quota", short)] : []),
		...(weekly ? [toUsageBucket("weekly", "Weekly quota", weekly)] : []),
	];
	const buckets = selected.length > 0 ? selected : fallbackBuckets(payload);
	if (buckets.length === 0) {
		throw new Error("Antigravity quota endpoint returned no displayable usage data.");
	}

	return {
		providerId: "google-antigravity",
		providerName: "Antigravity",
		capturedAt,
		source: "google-antigravity-quota",
		semantics: { kind: "consumer-subscription", label: "Google AI subscription quota" },
		buckets,
		metrics: [],
	};
}

function summaryBuckets(payload: GoogleAntigravityPayload): Record<string, unknown>[] {
	const groups = Array.isArray(payload.groups) ? payload.groups : [];
	return groups.flatMap((group) => {
		const buckets = asObject(group)?.buckets;
		return Array.isArray(buckets)
			? buckets.map(asObject).filter((value): value is Record<string, unknown> => value !== undefined)
			: [];
	});
}

function fallbackBuckets(payload: GoogleAntigravityPayload): UsageBucket[] {
	const raw = Array.isArray(payload.buckets)
		? payload.buckets.map(asObject).filter((value): value is Record<string, unknown> => value !== undefined)
		: [];
	const requestBuckets = raw.filter(
		(bucket) => String(bucket.tokenType ?? "").toUpperCase() === "REQUESTS",
	);
	const bucket = mostUsed(requestBuckets.length > 0 ? requestBuckets : raw);
	return bucket ? [toUsageBucket("quota", "Request quota", bucket)] : [];
}

function mostUsed(buckets: Record<string, unknown>[]): Record<string, unknown> | undefined {
	return buckets.reduce<Record<string, unknown> | undefined>((selected, bucket) => {
		const used = usedPercent(bucket);
		if (used === undefined) return selected;
		return !selected || used > (usedPercent(selected) ?? -1) ? bucket : selected;
	}, undefined);
}

function toUsageBucket(id: string, label: string, bucket: Record<string, unknown>): UsageBucket {
	const used = usedPercent(bucket);
	if (used === undefined) throw new Error("Antigravity quota bucket was incomplete.");
	const resetsAt = asEpochSeconds(bucket.resetTime);
	return {
		id,
		label,
		used,
		remaining: 100 - used,
		limit: 100,
		unit: "percent",
		...(resetsAt !== undefined ? { resetsAt } : {}),
	};
}

function usedPercent(bucket: Record<string, unknown>): number | undefined {
	const remaining = bucket.remainingFraction;
	if (typeof remaining !== "number" || !Number.isFinite(remaining)) return undefined;
	return (1 - Math.max(0, Math.min(1, remaining))) * 100;
}

function windowName(bucket: Record<string, unknown>): string {
	return typeof bucket.window === "string" ? bucket.window.toLowerCase() : "";
}

function isWeekly(value: string): boolean {
	return /week|7d|seven/u.test(value);
}

function isShort(value: string): boolean {
	return !isWeekly(value) && /5h|five.?hour|session|hour/u.test(value);
}

function asObject(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
}

function asEpochSeconds(value: unknown): number | undefined {
	if (typeof value !== "string" || !value.trim()) return undefined;
	const timestamp = Date.parse(value);
	return Number.isNaN(timestamp) ? undefined : Math.floor(timestamp / 1_000);
}
