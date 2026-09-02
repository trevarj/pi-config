import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import test from "node:test";
import agentwire, {
  createAgentwireExtension,
  createLineDecoder,
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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((fulfill, fail) => {
    resolve = fulfill;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function connectSocket(dir: string) {
  const sockets = readdirSync(dir).filter((name) => name.endsWith(".sock"));
  assert.equal(sockets.length, 1);
  const socket = connect(join(dir, sockets[0]));
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
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  return { socket, next };
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
  const withLatest = [
    ...branch,
    { id: "d", parentId: "c", type: "message", message: { role: "user", content: "latest" } },
  ];
  assert.deepEqual(serializeEntries(withLatest, undefined, 2).entries.map((entry) => entry.id), ["a", "c"]);
  assert.deepEqual(serializeEntries(withLatest, undefined, 2, true).entries.map((entry) => entry.id), ["c", "d"]);
});

test("prompt steers when busy and sends directly when idle", async () => {
  const idle = ports();
  await handleCommand({ id: 1, type: "prompt", message: "go" }, idle);
  assert.deepEqual(idle.calls, [["sendUserMessage", "go", undefined]]);
  const streaming = ports({ isIdle: () => false });
  await handleCommand({ type: "prompt", message: "go" }, streaming);
  assert.deepEqual(streaming.calls, [["sendUserMessage", "go", "steer"]]);
});

test("steer requires an active turn; follow_up queues while busy", async () => {
  const idle = ports();
  const denied = await handleCommand({ type: "steer", message: "x" }, idle);
  assert.equal(denied.success, false);
  const streaming = ports({ isIdle: () => false });
  await handleCommand({ type: "follow_up", message: "later" }, streaming);
  assert.deepEqual(streaming.calls, [["sendUserMessage", "later", "followUp"]]);
});

test("dispatches settings commands and reports failures", async () => {
  const good = ports();
  await handleCommand({ type: "set_thinking_level", level: "high" }, good);
  await handleCommand({ type: "set_session_name", name: "work" }, good);
  assert.deepEqual(good.calls, [
    ["setThinkingLevel", "high"],
    ["setSessionName", "work"],
  ]);
  const models = await handleCommand({ type: "get_available_models" }, good);
  assert.deepEqual(models.data, {
    models: [{ provider: "anthropic", id: "claude-1", name: "Claude", reasoning: true }],
  });
  const failing = ports({
    setModel: () => {
      throw new Error("model not found: a/b");
    },
  });
  const failure = await handleCommand(
    { id: 9, type: "set_model", provider: "a", modelId: "b" },
    failing,
  );
  assert.deepEqual(failure, {
    id: 9,
    type: "response",
    command: "set_model",
    success: false,
    error: "model not found: a/b",
  });
  const unknown = await handleCommand({ type: "bogus" }, good);
  assert.equal(unknown.success, false);
});

test("waits for async setting failures before correlating responses", async () => {
  const pending = Symbol("pending");
  const unavailable = deferred<void | boolean>();
  const unavailableResponse = handleCommand(
    { id: "model-false", type: "set_model", provider: "anthropic", modelId: "missing" },
    ports({ setModel: () => unavailable.promise }),
  );
  assert.equal(await Promise.race([unavailableResponse, Promise.resolve(pending)]), pending);
  unavailable.resolve(false);
  assert.deepEqual(await unavailableResponse, {
    id: "model-false",
    type: "response",
    command: "set_model",
    success: false,
    error: "model unavailable: anthropic/missing",
  });

  const rejectedModel = deferred<void | boolean>();
  const rejectedModelResponse = handleCommand(
    { id: "model-rejected", type: "set_model", provider: "anthropic", modelId: "broken" },
    ports({ setModel: () => rejectedModel.promise }),
  );
  assert.equal(await Promise.race([rejectedModelResponse, Promise.resolve(pending)]), pending);
  rejectedModel.reject(new Error("model registry unavailable"));
  assert.deepEqual(await rejectedModelResponse, {
    id: "model-rejected",
    type: "response",
    command: "set_model",
    success: false,
    error: "model registry unavailable",
  });

  const rejectedName = deferred<void>();
  const rejectedNameResponse = handleCommand(
    { id: "name-rejected", type: "set_session_name", name: "work" },
    ports({ setSessionName: () => rejectedName.promise }),
  );
  assert.equal(await Promise.race([rejectedNameResponse, Promise.resolve(pending)]), pending);
  rejectedName.reject(new Error("session rename failed"));
  assert.deepEqual(await rejectedNameResponse, {
    id: "name-rejected",
    type: "response",
    command: "set_session_name",
    success: false,
    error: "session rename failed",
  });
});

test("socket paths are unique and named by backend", () => {
  const env = { XDG_RUNTIME_DIR: "/run/user/agentwire-test" };
  assert.equal(socketDir(env, "pi"), join(env.XDG_RUNTIME_DIR, "agentwire", "pi"));
  assert.equal(socketDir(env, "omp"), join(env.XDG_RUNTIME_DIR, "agentwire", "omp"));
  assert.notEqual(socketDir(env, "pi"), socketDir(env, "omp"));
  assert.notEqual(socketPath(2, "pi"), socketPath(2, "pi"));
  assert.notEqual(socketPath(2, "omp"), socketPath(2, "omp"));
});

test("backend factories register only their dialect events", () => {
  const registered = (backend: "pi" | "omp") => {
    const events: string[] = [];
    const busEvents: string[] = [];
    createAgentwireExtension(backend)({
      on: (event) => events.push(event),
      sendUserMessage: () => {},
      setModel: () => {},
      setThinkingLevel: () => {},
      getThinkingLevel: () => "off",
      setSessionName: () => {},
      getSessionName: () => undefined,
      events: {
        on: (event) => busEvents.push(event),
        emit: () => {},
      },
    });
    return { events, busEvents };
  };

  assert.deepEqual(registered("pi"), {
    events: [
      "session_start",
      "session_info_changed",
      "model_select",
      "thinking_level_select",
      "agent_start",
      "agent_settled",
      "ui_prompt_start",
      "ui_prompt_end",
      "message_end",
      "tool_execution_start",
      "tool_execution_end",
      "session_shutdown",
    ],
    busEvents: ["pi-agents:snapshot"],
  });
  assert.deepEqual(registered("omp"), {
    events: [
      "session_start",
      "session_switch",
      "session_branch",
      "session_tree",
      "agent_start",
      "agent_end",
      "message_end",
      "tool_execution_start",
      "tool_execution_end",
      "session_shutdown",
    ],
    busEvents: [],
  });
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

test("serves hello, re-announce, and commands over the socket", async () => {
  process.env.XDG_RUNTIME_DIR = `${process.env.TMPDIR ?? "/tmp"}/agentwire-test-${process.pid}`;
  const handlers = new Map<string, (event: Record<string, unknown>, ctx: unknown) => unknown>();
  const busHandlers = new Map<string, (data: unknown) => void>();
  const sent: unknown[][] = [];
  agentwire({
    on: (event, handler) => handlers.set(event, handler),
    sendUserMessage: (content, options) => sent.push([content, options]),
    setModel: () => {},
    setThinkingLevel: () => {},
    getThinkingLevel: () => "medium",
    setSessionName: () => {},
    getSessionName: () => "my-session",
    events: {
      on: (event, handler) => busHandlers.set(event, handler),
      emit: () => {},
    },
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
    const { socket, next } = await connectSocket(socketDir(process.env, "pi"));

    const hello = await next();
    assert.equal(hello.type, "hello");
    assert.equal(hello.backend, "pi");
    assert.equal(hello.sessionId, "123_abc");
    assert.equal(hello.sessionName, "my-session");
    assert.equal(hello.busy, false);
    assert.equal(hello.waiting, false);
    assert.deepEqual(hello.subagents, []);
    assert.equal(typeof hello.startedAt, "string");
    assert.equal(typeof hello.updatedAt, "string");
    socket.write(encodeFrame({ id: "state", type: "get_state" }));
    const current = await next();
    assert.equal((current.data as Record<string, unknown>).backend, "pi");
    busHandlers.get("pi-agents:snapshot")?.({ agents: [{ id: "worker", status: "running", prompt: "omitted upstream" }] });
    const agentChanged = await next();
    assert.deepEqual(agentChanged.subagents, []);
    busHandlers.get("pi-agents:snapshot")?.({ version: 1, agents: [{ id: "worker", name: "Worker", kind: "implementer", status: "running", prompt: "private" }] });
    const safeAgentChanged = await next();
    assert.deepEqual(safeAgentChanged.subagents, [{ id: "worker", name: "Worker", kind: "implementer", status: "running" }]);
    // A reconnecting client receives current session state again.
    handlers.get("session_info_changed")?.({}, ctx);
    const changed = await next();
    assert.equal(changed.type, "session_changed");
    assert.equal(changed.backend, "pi");
    assert.equal(changed.busy, false);

    handlers.get("ui_prompt_start")?.({}, ctx);
    const waiting = await next();
    assert.equal(waiting.type, "session_changed");
    assert.equal(waiting.waiting, true);
    handlers.get("ui_prompt_end")?.({}, ctx);
    assert.equal((await next()).waiting, false);

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

test("OMP tags socket state and settles a terminal end only after an idle timeout", async () => {
  process.env.XDG_RUNTIME_DIR = `${process.env.TMPDIR ?? "/tmp"}/agentwire-test-${process.pid}`;
  const handlers = new Map<string, (event: Record<string, unknown>, ctx: unknown) => unknown>();
  const timeouts: (() => void)[] = [];
  let idle = false;
  createAgentwireExtension("omp")({
    on: (event, handler) => handlers.set(event, handler),
    sendUserMessage: () => {},
    setModel: () => {},
    setThinkingLevel: () => {},
    getThinkingLevel: () => "medium",
    setSessionName: () => {},
    getSessionName: () => "omp-session",
  });
  const ctx = {
    cwd: "/tmp/project",
    model: { provider: "anthropic", id: "claude-1", name: "Claude" },
    isIdle: () => idle,
    setTimeout: (callback: () => void, ms?: number) => {
      assert.equal(ms, 0);
      timeouts.push(callback);
    },
    abort: () => {},
    getContextUsage: () => undefined,
    modelRegistry: { getAvailable: () => [] },
    sessionManager: {
      getSessionFile: () => "/tmp/sessions/omp.jsonl",
      getSessionId: () => "omp-id",
      getBranch: () => [],
    },
  };
  handlers.get("session_start")?.({}, ctx);
  try {
    const { socket, next } = await connectSocket(socketDir(process.env, "omp"));
    const hello = await next();
    assert.equal(hello.type, "hello");
    assert.equal(hello.backend, "omp");

    socket.write(encodeFrame({ id: "state", type: "get_state" }));
    const initialState = await next();
    assert.equal((initialState.data as Record<string, unknown>).backend, "omp");

    handlers.get("session_switch")?.({}, ctx);
    const changed = await next();
    assert.equal(changed.type, "session_changed");
    assert.equal(changed.backend, "omp");

    handlers.get("agent_start")?.({}, ctx);
    assert.equal((await next()).type, "agent_start");

    handlers.get("agent_end")?.({ willContinue: true }, ctx);
    assert.deepEqual(timeouts, []);
    socket.write(encodeFrame({ id: "continuing", type: "get_state" }));
    const continuing = await next();
    assert.equal((continuing.data as Record<string, unknown>).busy, true);

    handlers.get("agent_end")?.({ willContinue: false }, ctx);
    assert.equal(timeouts.length, 1);
    socket.write(encodeFrame({ id: "before-timeout", type: "get_state" }));
    const beforeTimeout = await next();
    assert.equal((beforeTimeout.data as Record<string, unknown>).busy, true);

    idle = true;
    timeouts.shift()?.();
    assert.equal((await next()).type, "agent_settled");
    socket.write(encodeFrame({ id: "settled", type: "get_state" }));
    const settled = await next();
    assert.equal((settled.data as Record<string, unknown>).busy, false);
    socket.destroy();
  } finally {
    handlers.get("session_shutdown")?.({}, ctx);
  }
});
