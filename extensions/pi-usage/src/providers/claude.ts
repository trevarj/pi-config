import type { ClaudeUsagePayload, UsageBucket, UsageReport } from "../types.js";

const WINDOWS = [
  { key: "five_hour", id: "five-hour", label: "5-hour" },
  { key: "seven_day", id: "weekly", label: "Weekly" },
  { key: "seven_day_sonnet", id: "weekly-sonnet", label: "Weekly Sonnet" },
  { key: "seven_day_opus", id: "weekly-opus", label: "Weekly Opus" },
] as const;

export function normalizeClaudeUsagePayload(payload: ClaudeUsagePayload, capturedAt: number): UsageReport {
  const buckets = WINDOWS.flatMap((window) => {
    const value = asObject(payload[window.key]);
    const used = asPercent(value?.utilization);
    if (used === undefined) return [];
    const resetsAt = asEpochSeconds(value?.resets_at);
    return [{
      id: window.id,
      label: `${window.label} limit`,
      used,
      remaining: 100 - used,
      limit: 100,
      unit: "percent" as const,
      ...(resetsAt === undefined ? {} : { resetsAt }),
    }];
  });
  if (!buckets.length) throw new Error("Claude usage endpoint returned no displayable usage data.");

  return {
    providerId: "anthropic",
    providerName: "Claude",
    capturedAt,
    source: "anthropic-oauth-usage",
    semantics: { kind: "consumer-subscription", label: "Claude subscription limits" },
    buckets,
    metrics: [],
  };
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function asPercent(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.min(100, value) : undefined;
}

function asEpochSeconds(value: unknown): number | undefined {
  const timestamp = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isNaN(timestamp) ? undefined : Math.floor(timestamp / 1000);
}
