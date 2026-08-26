import assert from "node:assert/strict";
import test from "node:test";
import herdrWaiting, { lastAssistantMessageIsQuestion } from "./herdr-waiting.ts";

test("recognizes only assistant replies ending in a question", () => {
  assert.equal(
    lastAssistantMessageIsQuestion([
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "Which?" }] } },
    ]),
    true,
  );
  assert.equal(
    lastAssistantMessageIsQuestion([
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "Done." }] } },
    ]),
    false,
  );
});

test("reports a settled assistant question until the next run", () => {
  const handlers = new Map<string, (event: any, ctx?: any) => void>();
  const emitted: unknown[] = [];
  herdrWaiting({
    events: { emit: (_name: string, data: unknown) => emitted.push(data) },
    on: (name: string, handler: (event: any, ctx?: any) => void) => handlers.set(name, handler),
  } as any);

  handlers.get("agent_settled")?.({}, {
    sessionManager: {
      getBranch: () => [
        { message: { role: "assistant", content: [{ type: "text", text: "Which option?" }] } },
      ],
    },
  });
  handlers.get("agent_start")?.({});

  assert.deepEqual(emitted, [
    { active: true, label: "waiting for input" },
    { active: false },
  ]);
});

test("reports plan questions as waiting until tool completion", () => {
  const handlers = new Map<string, (event: any) => void>();
  const emitted: unknown[] = [];
  const pi = {
    events: { emit: (_name: string, data: unknown) => emitted.push(data) },
    on: (name: string, handler: (event: any) => void) => handlers.set(name, handler),
  };

  herdrWaiting(pi as any);
  handlers.get("tool_execution_start")?.({
    toolCallId: "question-1",
    toolName: "plan_mode_question",
  });
  handlers.get("tool_execution_start")?.({
    toolCallId: "question-1",
    toolName: "plan_mode_question",
  });
  handlers.get("tool_execution_end")?.({
    toolCallId: "question-1",
    toolName: "plan_mode_question",
  });
  handlers.get("tool_execution_end")?.({
    toolCallId: "question-1",
    toolName: "plan_mode_question",
  });

  assert.deepEqual(emitted, [
    { active: true, label: "waiting for input" },
    { active: false },
  ]);
});
