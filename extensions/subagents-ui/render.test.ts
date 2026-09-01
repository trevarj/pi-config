import assert from "node:assert/strict";
import test from "node:test";
import { resultText, subagentCallSubject, summarizeSubagentResult } from "./render.ts";

test("formats compact subagent calls", () => {
  assert.equal(subagentCallSubject("subagent_inspect", {}), "jobs");
  assert.equal(subagentCallSubject("subagent_wait", { jobId: "job_1", timeout: 30 }), "job_1 · 30s");
  assert.equal(subagentCallSubject("subagent_send", { requestId: "req_1" }), "req_1");
});

test("summarizes waits without dumping result JSON", () => {
  assert.deepEqual(
    summarizeSubagentResult("subagent_wait", { jobId: "job_1", state: "running", timedOut: true }),
    { text: "job_1 · running · wait expired", tone: "warning" },
  );
  assert.deepEqual(
    summarizeSubagentResult("subagent_wait", { jobId: "job_1", state: "completed", timedOut: false, result: "large child output" }),
    { text: "job_1 · completed", tone: "success" },
  );
  assert.deepEqual(
    summarizeSubagentResult("subagent_cancel", { jobId: "job_1", state: "cancelled" }),
    { text: "job_1 · cancelled", tone: "warning" },
  );
});

test("summarizes inspected jobs and messages", () => {
  assert.deepEqual(
    summarizeSubagentResult("subagent_inspect", {
      jobs: [{ state: "running" }, { state: "completed" }, { state: "completed" }],
      omitted: { jobs: 2 },
    }),
    { text: "3 jobs · 1 running · 2 completed · 2 omitted", tone: "success" },
  );
  assert.deepEqual(
    summarizeSubagentResult("subagent_send", { requestId: "req_1", accepted: true, duplicate: false }, { recipient: "job_1" }),
    { text: "req_1 · sent", tone: "success" },
  );
});

test("keeps sanitized full text only for expanded rendering", () => {
  assert.equal(
    resultText([{ type: "text", text: "one\x1b]0;bad\x07" }, { type: "image" }, { type: "text", text: "two\u202e" }]),
    "one\ntwo",
  );
});
