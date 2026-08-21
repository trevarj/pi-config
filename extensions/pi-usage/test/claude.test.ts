import assert from "node:assert/strict";
import test from "node:test";
import { formatUsageStatusline } from "../src/format.ts";
import { normalizeClaudeUsagePayload } from "../src/providers/claude.ts";

test("Claude usage reports remaining five-hour and weekly limits", () => {
  const report = normalizeClaudeUsagePayload({
    five_hour: { utilization: 3, resets_at: "2026-08-20T20:49:59Z" },
    seven_day: { utilization: 80, resets_at: "2026-08-24T04:59:59Z" },
  }, 0);

  assert.deepEqual(report.buckets.map(({ id, remaining }) => ({ id, remaining })), [
    { id: "five-hour", remaining: 97 },
    { id: "weekly", remaining: 20 },
  ]);
  assert.equal(formatUsageStatusline(report), "claude 97% 5h");
});
