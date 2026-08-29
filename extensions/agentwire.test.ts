import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import test from "node:test";
import agentwire, {
  createLineDecoder,
  createSubagentRegistry,
  encodeFrame,
  handleCommand,
  pruneArgs,
  serializeEntries,
  serializeMessage,
  socketDir,
  socketPath,
  truncateText,
  type CommandPorts,
} from "./agentwire.ts";

function ports(overrides: Partial<CommandPorts> = {}): CommandPorts & { calls: unknown[][] } {
  const calls: unknown[][] = [];
  const record = (name: string) => (...args: unknown[]) => {
    calls.push([name, ...args]);
  };
  return {
    calls,
    state: () => ({ sessionId: "s1", busy: false }),
    isIdle: () => true,
    sendUserMessage: record("sendUserMessage"),
    abort: record("abort"),
    entries: () => ({ entries: [], leafId: null }),
    availableModels: () => [
      { provider: "anthropic", id: "claude-1", name: "Claude", reasoning: true },
    ],
    setModel: record("setModel"),
    setThinkingLevel: record("setThinkingLevel"),
    setSessionName: record("setSessionName"),
    stats: () => ({ contextUsage: null }),
    ...overrides,
  };
}

test("line decoder splits on LF only and strips CR", () => {
  const lines: string[] = [];
  const decode = createLineDecoder((line) => lines.push(line));
  decode('{"a":1}\r\n{"b":"x\u2028y"}\n{"partial"');
  assert.deepEqual(lines, ['{"a":1}', '{"b":"x\u2028y"}']);
  decode(':2}\n');
  assert.deepEqual(lines.at(-1), '{"partial":2}');
});

test("frames end with a single LF", () => {
  assert.equal(encodeFrame({ type: "hello" }), '{"type":"hello"}\n');
});

test("serializes user, assistant, and toolResult messages", () => {
  assert.deepEqual(serializeMessage({ role: "user", content: "hi", timestamp: 5 }), {
    role: "user",
    text: "hi",
    timestamp: 5,
  });
  const assistant = serializeMessage({
    role: "assistant",
    content: [
      { type: "thinking", thinking: "hidden" },
      { type: "text", text: "answer" },
      { type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls", big: { nested: 1 } } },
    ],
    stopReason: "toolUse",
  });
  assert.equal(assistant?.text, "answer");
  assert.equal(assistant?.stopReason, "toolUse");
  assert.deepEqual(assistant?.toolCalls, [{ id: "t1", name: "bash", arguments: { command: "ls" } }]);
  const result = serializeMessage({
    role: "toolResult",
    toolCallId: "t1",
    toolName: "bash",
    content: [{ type: "text", text: "out" }],
    isError: false,
  });
  assert.equal(result?.text, "out");
  assert.equal(serializeMessage({ role: "assistant", content: [] }), null);
});

test("prunes bulk tool arguments and truncates long text", () => {
  const pruned = pruneArgs({ command: "ls", timeout: 5, ok: true, edits: [{ a: 1 }], blob: {} });
  assert.deepEqual(pruned, { command: "ls", timeout: 5, ok: true });
  const long = truncateText("x".repeat(40000), 100);
  assert.ok(long.endsWith("…[truncated]"));
  assert.ok(Buffer.byteLength(long) < 200);
});

test("entry serialization pages with a strict cursor", () => {
  const branch = [
    { id: "a", parentId: null, type: "message", message: { role: "user", content: "one" } },
    { id: "b", parentId: "a", type: "custom", customType: "x" },
    { id: "c", parentId: "b", type: "message", message: { role: "assistant", content: [{ type: "text", text: "two" }] } },
  ];
  const all = serializeEntries(branch);
  assert.deepEqual(all.entries.map((entry) => entry.id), ["a", "c"]);
  assert.equal(all.leafId, "c");
  const after = serializeEntries(branch, "a");
  assert.deepEqual(after.entries.map((entry) => entry.id), ["c"]);
  assert.throws(() => serializeEntries(branch, "nope"));
});

test("prompt steers when busy and sends directly when idle", () => {
  const idle = ports();
  handleCommand({ id: 1, type: "prompt", message: "go" }, idle);
  assert.deepEqual(idle.calls, [["sendUserMessage", "go", undefined]]);
  const streaming = ports({ isIdle: () => false });
  handleCommand({ type: "prompt", message: "go" }, streaming);
  assert.deepEqual(streaming.calls, [["sendUserMessage", "go", "steer"]]);
});

test("steer requires an active turn; follow_up queues while busy", () => {
  const idle = ports();
  const denied = handleCommand({ type: "steer", message: "x" }, idle);
  assert.equal(denied.success, false);
  const streaming = ports({ isIdle: () => false });
  handleCommand({ type: "follow_up", message: "later" }, streaming);
  assert.deepEqual(streaming.calls, [["sendUserMessage", "later", "followUp"]]);
});

test("dispatches settings commands and reports failures", () => {
  const good = ports();
  handleCommand({ type: "set_thinking_level", level: "high" }, good);
  handleCommand({ type: "set_session_name", name: "work" }, good);
  assert.deepEqual(good.calls, [
    ["setThinkingLevel", "high"],
    ["setSessionName", "work"],
  ]);
  const models = handleCommand({ type: "get_available_models" }, good);
  assert.deepEqual(models.data, {
    models: [{ provider: "anthropic", id: "claude-1", name: "Claude", reasoning: true }],
  });
  const failing = ports({
    setModel: () => {
      throw new Error("model not found: a/b");
    },
  });
  const failure = handleCommand({ id: 9, type: "set_model", provider: "a", modelId: "b" }, failing);
  assert.deepEqual(failure, {
    id: 9,
    type: "response",
    command: "set_model",
    success: false,
    error: "model not found: a/b",
  });
  const unknown = handleCommand({ type: "bogus" }, good);
  assert.equal(unknown.success, false);
});

test("subagent registry tracks the created → started → terminal lifecycle", () => {
  const registry = createSubagentRegistry(() => 1000);
  assert.equal(registry.apply("subagents:created", { id: "a", type: "Explore", description: "look", isBackground: true }), true);
  assert.deepEqual(registry.list(), [
    { id: "a", type: "Explore", description: "look", status: "queued", isBackground: true },
  ]);
  registry.apply("subagents:started", { id: "a", type: "Explore", description: "look" });
  assert.equal(registry.list()[0].status, "running");
  // `started` may be the first event a scheduler or RPC spawn produces.
  registry.apply("subagents:started", { id: "b", type: "Terra", description: "build" });
  assert.deepEqual(registry.list().map((agent) => [agent.id, agent.status, agent.isBackground]), [
    ["a", "running", true],
    ["b", "running", false],
  ]);
  registry.apply("subagents:completed", {
    id: "a", type: "Explore", description: "look", toolUses: 7, durationMs: 4200, tokens: 1234,
  });
  registry.apply("subagents:failed", {
    id: "b", type: "Terra", description: "build", toolUses: 2, durationMs: 90, tokens: { input: 5 },
  });
  const [completed, failed] = registry.list();
  assert.deepEqual(completed, {
    id: "a", type: "Explore", description: "look", status: "completed", isBackground: true,
    toolUses: 7, durationMs: 4200, tokens: 1234,
  });
  // A non-numeric `tokens` is dropped rather than stringified onto the wire.
  assert.deepEqual(failed, {
    id: "b", type: "Terra", description: "build", status: "failed", isBackground: false,
    toolUses: 2, durationMs: 90,
  });
  assert.equal(registry.apply("subagents:steered", { id: "a" }), false);
  assert.equal(registry.apply("subagents:created", { type: "Explore" }), false);
});

test("subagent registry caps terminal agents at ten and keeps every live one", () => {
  const registry = createSubagentRegistry(() => 1000);
  for (let index = 0; index < 14; index += 1) {
    registry.apply("subagents:created", { id: `t${index}`, type: "Terra", description: "x" });
    registry.apply("subagents:completed", { id: `t${index}`, type: "Terra", description: "x" });
  }
  registry.apply("subagents:started", { id: "live", type: "Terra", description: "x" });
  registry.apply("subagents:created", { id: "waiting", type: "Terra", description: "x" });
  const ids = registry.list().map((agent) => agent.id);
  assert.deepEqual(ids, [
    "t4", "t5", "t6", "t7", "t8", "t9", "t10", "t11", "t12", "t13", "live", "waiting",
  ]);
});

test("subagent registry expires terminal agents after five minutes", () => {
  let clock = 0;
  const registry = createSubagentRegistry(() => clock);
  registry.apply("subagents:started", { id: "live", type: "Terra", description: "x" });
  registry.apply("subagents:completed", { id: "done", type: "Terra", description: "x" });
  clock = 5 * 60 * 1000 - 1;
  assert.deepEqual(registry.list().map((agent) => agent.id), ["live", "done"]);
  clock = 5 * 60 * 1000;
  // Expiry is enforced on read, so a quiet session does not strand stale rows.
  assert.deepEqual(registry.list().map((agent) => agent.id), ["live"]);
});

test("subagent descriptions are truncated to 200 bytes", () => {
  const registry = createSubagentRegistry(() => 0);
  registry.apply("subagents:created", { id: "a", type: "Terra", description: "y".repeat(500) });
  const description = registry.list()[0].description;
  assert.ok(description.endsWith("…[truncated]"));
  assert.ok(Buffer.byteLength(description) < 260);
});

test("socket paths do not collide for the same PID", () => {
  assert.notEqual(socketPath(2), socketPath(2));
});

test("extension no-ops entirely under AGENTWIRE_SPAWNED", () => {
  process.env.AGENTWIRE_SPAWNED = "1";
  try {
    const registered: string[] = [];
    agentwire({
      on: (event: string) => registered.push(event),
      sendUserMessage: () => {},
      setModel: () => {},
      setThinkingLevel: () => {},
      getThinkingLevel: () => "off",
      setSessionName: () => {},
      getSessionName: () => undefined,
    });
    assert.deepEqual(registered, []);
  } finally {
    delete process.env.AGENTWIRE_SPAWNED;
  }
});

test("serves hello, re-announce, events, and commands over the socket", async () => {
  process.env.XDG_RUNTIME_DIR = `${process.env.TMPDIR ?? "/tmp"}/agentwire-test-${process.pid}`;
  const handlers = new Map<string, (event: Record<string, unknown>, ctx: unknown) => unknown>();
  const busHandlers = new Map<string, (payload: unknown) => void>();
  const sent: unknown[][] = [];
  agentwire({
    on: (event, handler) => handlers.set(event, handler),
    events: { on: (event, handler) => busHandlers.set(event, handler) },
    sendUserMessage: (content, options) => sent.push([content, options]),
    setModel: () => {},
    setThinkingLevel: () => {},
    getThinkingLevel: () => "medium",
    setSessionName: () => {},
    getSessionName: () => "my-session",
  });
  const ctx = {
    cwd: "/tmp/project",
    model: { provider: "anthropic", id: "claude-1", name: "Claude" },
    isIdle: () => true,
    abort: () => {},
    getContextUsage: () => undefined,
    modelRegistry: { getAvailable: () => [] },
    sessionManager: {
      getSessionFile: () => "/tmp/sessions/123_abc.jsonl",
      getBranch: () => [
        { id: "e1", parentId: null, type: "message", message: { role: "user", content: "hi" } },
      ],
    },
  };
  handlers.get("session_start")?.({}, ctx);
  try {
    const sockets = readdirSync(socketDir()).filter((name) => name.endsWith(".sock"));
    assert.equal(sockets.length, 1);
    const socket = connect(join(socketDir(), sockets[0]));
    socket.setEncoding("utf8");
    const frames: Record<string, unknown>[] = [];
    const waiters: ((frame: Record<string, unknown>) => void)[] = [];
    const next = () =>
      new Promise<Record<string, unknown>>((resolve) => {
        const frame = frames.shift();
        if (frame) resolve(frame);
        else waiters.push(resolve);
      });
    socket.on(
      "data",
      createLineDecoder((line) => {
        const frame = JSON.parse(line) as Record<string, unknown>;
        const waiter = waiters.shift();
        if (waiter) waiter(frame);
        else frames.push(frame);
      }),
    );
    await new Promise((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });

    const hello = await next();
    assert.equal(hello.type, "hello");
    assert.equal(hello.sessionId, "123_abc");
    assert.equal(hello.sessionName, "my-session");
    assert.equal(hello.busy, false);
    assert.deepEqual(hello.subagents, []);

    busHandlers.get("subagents:created")?.({
      id: "sub-1",
      type: "Explore",
      description: "map the repo",
      isBackground: true,
    });
    const created = await next();
    assert.deepEqual(created, {
      type: "subagent_update",
      agents: [
        {
          id: "sub-1",
          type: "Explore",
          description: "map the repo",
          status: "queued",
          isBackground: true,
        },
      ],
    });
    busHandlers.get("subagents:started")?.({ id: "sub-1", type: "Explore", description: "map the repo" });
    const started = await next();
    assert.equal((started.agents as { status: string }[])[0].status, "running");
    // The current list also rides `session_changed`, so a reconnecting client resyncs.
    handlers.get("session_info_changed")?.({}, ctx);
    const changed = await next();
    assert.equal(changed.type, "session_changed");
    assert.equal((changed.subagents as { id: string }[])[0].id, "sub-1");

    handlers.get("agent_start")?.({}, ctx);
    assert.equal((await next()).type, "agent_start");
    handlers.get("message_end")?.(
      { message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" } },
      ctx,
    );
    const message = await next();
    assert.equal(message.type, "message_end");
    assert.equal((message.message as { text: string }).text, "done");
    handlers.get("agent_settled")?.({}, ctx);
    assert.equal((await next()).type, "agent_settled");

    socket.write(encodeFrame({ id: "r1", type: "get_entries" }));
    const entries = await next();
    assert.equal(entries.success, true);
    assert.equal((entries.data as { leafId: string }).leafId, "e1");

    socket.write(encodeFrame({ id: "r2", type: "prompt", message: "hello" }));
    const accepted = await next();
    assert.deepEqual(accepted, { id: "r2", type: "response", command: "prompt", success: true });
    assert.deepEqual(sent, [["hello", undefined]]);

    socket.write("not json\n");
    const parseError = await next();
    assert.equal(parseError.success, false);
    socket.destroy();
  } finally {
    handlers.get("session_shutdown")?.({}, ctx);
  }
});
