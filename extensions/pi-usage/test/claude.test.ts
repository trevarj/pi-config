import assert from "node:assert/strict";
import test from "node:test";
import { formatUsageStatusline, formatWeeklyResetStatus } from "../src/format.ts";
import { normalizeClaudeUsagePayload } from "../src/providers/claude.ts";
import { normalizeGoogleAntigravityPayload } from "../src/providers/google-antigravity.ts";
import { normalizeXaiBillingPayload } from "../src/providers/xai.ts";

test("Claude usage reports remaining five-hour and weekly limits", () => {
  const report = normalizeClaudeUsagePayload({
    five_hour: { utilization: 3, resets_at: "2026-08-20T20:49:59Z" },
    seven_day: { utilization: 80, resets_at: "2026-08-24T04:59:59Z" },
  }, 0);

  assert.deepEqual(report.buckets.map(({ id, remaining }) => ({ id, remaining })), [
    { id: "five-hour", remaining: 97 },
    { id: "weekly", remaining: 20 },
  ]);
  assert.equal(formatUsageStatusline(report), "claude 97% 5h 20% wk");
});

test("Grok usage reports weekly credits and reset", () => {
  const report = normalizeXaiBillingPayload({
    config: {
      creditUsagePercent: 12.5,
      currentPeriod: { end: "2026-08-25T14:30:00Z" },
    },
  }, 0);

  assert.equal(formatUsageStatusline(report), "grok 88% wk");
  assert.equal(formatWeeklyResetStatus(report), "↻ Tue 14:30");
});

test("weekly reset stays hidden when missing or invalid", () => {
  for (const end of [undefined, "not-a-date"]) {
    const report = normalizeXaiBillingPayload({
      config: { creditUsagePercent: 10, currentPeriod: { end } },
    }, 0);
    assert.equal(formatWeeklyResetStatus(report), undefined);
  }
});

test("Antigravity usage reports most-used weekly quota and reset", () => {
  const report = normalizeGoogleAntigravityPayload({
    groups: [{
      buckets: [
        { window: "7d", remainingFraction: 0.75, resetTime: "2026-08-26T09:15:00Z" },
        { window: "seven-day", remainingFraction: 0.9 },
      ],
    }],
  }, 0);

  assert.equal(formatUsageStatusline(report), "agy 75% wk");
  assert.equal(formatWeeklyResetStatus(report), "↻ Wed 09:15");
});

test("new subscription adapters reject malformed payloads", () => {
  assert.throws(() => normalizeXaiBillingPayload({}, 0), /no displayable usage data/iu);
  assert.throws(
    () => normalizeGoogleAntigravityPayload({}, 0),
    /no displayable usage data/iu,
  );
});
