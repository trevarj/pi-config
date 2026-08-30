import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { emptyState, readState, writeState, type RunLease, type Snapshot } from "./core.ts";
import { ORGANIZER_TOOLS, formatMoscow, formatStatus, registerOrganizer } from "./index.ts";

class Bus {
  handlers = new Map<string, Set<(payload: any) => void>>();
  emitted: Array<[string, any]> = [];
  on(event: string, handler: (payload: any) => void): () => void {
    const set = this.handlers.get(event) ?? new Set();
    set.add(handler);
    this.handlers.set(event, set);
    return () => set.delete(handler);
  }
  emit(event: string, payload: any): void {
    this.emitted.push([event, payload]);
    for (const handler of [...(this.handlers.get(event) ?? [])]) handler(payload);
  }
}

function markdown(words = 500): string {
  const filler = Array.from({ length: words }, (_, index) => `word${index}`).join(" ");
  return `# Organizer\n\n## Pulse\n${filler}\n\n## Needs attention\nnone\n\n## Active projects\nnone\n\n## Pi sessions and agents\nnone\n\n## Next three actions\n1. one\n2. two\n3. three`;
}

function harness(activeTools: string[] = ["read", "bash", ...ORGANIZER_TOOLS]) {
  const bus = new Bus();
  const lifecycle = new Map<string, (event: any, ctx: any) => unknown>();
  const commands = new Map<string, any>();
  const tools = new Map<string, any>();
  const active = [...activeTools];
  const api = {
    events: bus,
    on: (event: string, handler: (event: any, ctx: any) => unknown) => lifecycle.set(event, handler),
    registerCommand: (name: string, options: any) => commands.set(name, options),
    registerTool: (tool: any) => tools.set(tool.name, tool),
    getActiveTools: () => [...active],
    setActiveTools: (names: string[]) => { active.splice(0, active.length, ...names); },
  };
  return { bus, lifecycle, commands, tools, active, api };
}

function context(cwd: string, notices: unknown[][] = [], editors: unknown[][] = []) {
  return {
    cwd,
    mode: "tui",
    ui: {
      notify: (...args: unknown[]) => notices.push(args),
      editor: async (...args: unknown[]) => { editors.push(args); return "ignored edit"; },
    },
  };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
const lease = (runId: string, closed: string[] = []): RunLease => ({
  runId,
  async close() { closed.push(runId); },
});

test("ordinary sessions deactivate internal tools; organizer child keeps only both", () => {
  const dir = mkdtempSync(join(tmpdir(), "organizer-mode-"));
  const ordinary = harness();
  registerOrganizer(ordinary.api as any, { statePath: join(dir, "state.json"), reportPath: join(dir, "report.md"), organizerDir: dir, watchDir: () => ({ close() {} }) });
  ordinary.lifecycle.get("session_start")?.({}, context("/workspace/project"));
  assert.deepEqual(ordinary.active, ["read", "bash"]);

  const child = harness([...ORGANIZER_TOOLS]);
  registerOrganizer(child.api as any, { statePath: join(dir, "child-state.json"), reportPath: join(dir, "child-report.md"), organizerDir: dir, watchDir: () => ({ close() {} }) });
  child.lifecycle.get("session_start")?.({}, context("/workspace/.pi-organizer"));
  assert.deepEqual(child.active, [...ORGANIZER_TOOLS]);
});

test("commands display report, reject outside status, and clean watcher", async () => {
  const dir = mkdtempSync(join(tmpdir(), "organizer-command2-"));
  const h = harness();
  const notices: unknown[][] = [];
  const editors: unknown[][] = [];
  let closed = 0;
  registerOrganizer(h.api as any, {
    statePath: join(dir, "state.json"), reportPath: join(dir, "report.md"), organizerDir: dir,
    organizerCwd: "/organizer", watchDir: () => ({ close: () => { closed += 1; } }),
  });
  const ctx = context("/project", notices, editors);
  h.lifecycle.get("session_start")?.({}, ctx);
  await h.commands.get("organizer").handler("show", ctx);
  assert.match(String(editors[0][1]), /No report/);
  await h.commands.get("organizer").handler("status", ctx);
  assert.match(String(notices.at(-1)?.[0]), /organizer pane/);
  h.lifecycle.get("session_shutdown")?.({}, ctx);
  assert.equal(closed, 1);
});

test("report watcher debounces successful publication and stops on shutdown", () => {
  const dir = mkdtempSync(join(tmpdir(), "organizer-watch-"));
  const statePath = join(dir, "state.json");
  const h = harness();
  const notices: unknown[][] = [];
  let watched: (() => void) | undefined;
  let timer: (() => void) | undefined;
  let clears = 0;
  let closed = 0;
  registerOrganizer(h.api as any, {
    statePath, reportPath: join(dir, "report.md"), organizerDir: dir,
    watchDir: (_path, callback) => { watched = callback; return { close: () => { closed += 1; } }; },
    setTimer: (callback) => { timer = callback; return callback; },
    clearTimer: () => { clears += 1; },
  });
  const ctx = context("/project", notices);
  h.lifecycle.get("session_start")?.({}, ctx);
  writeState({ ...emptyState(), lastSuccessAt: "2026-08-30T06:00:00Z" }, statePath);
  watched?.();
  watched?.();
  timer?.();
  assert.deepEqual(notices, [["Organizer report updated", "info"]]);
  assert.ok(clears >= 1);
  h.lifecycle.get("session_shutdown")?.({}, ctx);
  assert.equal(closed, 1);
});

test("refresh spawns once and synchronously consumes lifecycle result before returning", async () => {
  const dir = mkdtempSync(join(tmpdir(), "organizer-rpc-"));
  const h = harness();
  const notices: unknown[][] = [];
  const closed: string[] = [];
  const organizerCwd = join(dir, "cwd");
  registerOrganizer(h.api as any, {
    statePath: join(dir, "state.json"), reportPath: join(dir, "report.md"), organizerDir: dir,
    organizerCwd, watchDir: () => ({ close() {} }),
    acquireLease: async () => lease("run-1", closed),
  });
  const ctx = context("/project", notices);
  h.lifecycle.get("session_start")?.({}, ctx);
  h.bus.on("subagents:rpc:spawn", (request) => {
    assert.equal(request.type, "organizer");
    assert.match(request.prompt, /run-1/);
    assert.deepEqual(request.options, { description: "refresh organizer report", isBackground: true, cwd: organizerCwd });
    h.bus.emit(`subagents:rpc:spawn:reply:${request.requestId}`, { success: true, data: { id: "agent-1" } });
  });
  h.bus.emit("subagents:ready", {});
  await h.commands.get("organizer").handler("refresh", ctx);
  await tick();
  await h.commands.get("organizer").handler("refresh", ctx);
  assert.match(String(notices.at(-1)?.[0]), /already in flight/);
  h.bus.emit("organizer:snapshot", { runId: "run-1", snapshotId: "current" });
  h.bus.emit("organizer:published", { timestamp: new Date().toISOString(), runId: "other", snapshotId: "current" });
  await h.commands.get("organizer").handler("refresh", ctx);
  assert.match(String(notices.at(-1)?.[0]), /already in flight/);
  h.bus.emit("organizer:published", { timestamp: new Date().toISOString(), runId: "run-1", snapshotId: "current" });
  const before = h.bus.emitted.length;
  h.bus.emit("subagents:completed", { id: "agent-1", status: "completed" });
  const emittedInside = h.bus.emitted.slice(before).map(([event]) => event);
  assert.deepEqual(emittedInside.slice(0, 2), ["subagents:completed", "subagents:rpc:consume"]);
  await tick();
  assert.deepEqual(closed, ["run-1"]);
  assert.equal(readState(join(dir, "state.json")).lastError, null);
});

test("spawn failure records bounded error and permits another refresh", async () => {
  const dir = mkdtempSync(join(tmpdir(), "organizer-rpc-fail-"));
  const h = harness();
  let run = 0;
  registerOrganizer(h.api as any, {
    statePath: join(dir, "state.json"), reportPath: join(dir, "report.md"), organizerDir: dir,
    organizerCwd: join(dir, "cwd"), watchDir: () => ({ close() {} }),
    acquireLease: async () => lease(`run-${++run}`),
  });
  const ctx = context("/project");
  h.lifecycle.get("session_start")?.({}, ctx);
  let attempts = 0;
  h.bus.on("subagents:rpc:spawn", (request) => {
    attempts += 1;
    h.bus.emit(`subagents:rpc:spawn:reply:${request.requestId}`, { success: false, error: "failed\nAuthorization: secret" });
  });
  h.bus.emit("subagents:ready", {});
  await h.commands.get("organizer").handler("refresh", ctx);
  await tick();
  await h.commands.get("organizer").handler("refresh", ctx);
  await tick();
  assert.equal(attempts, 2);
  assert.ok(!readState(join(dir, "state.json")).lastError?.includes("secret"));
});

test("snapshot is single-use; publish rejects stale/replay and terminates after valid atomic publish", async () => {
  const dir = mkdtempSync(join(tmpdir(), "organizer-tools-"));
  const h = harness([...ORGANIZER_TOOLS]);
  const snapshot: Snapshot = {
    version: 1, id: "current", timestamp: "2026-08-30T00:00:00Z",
    window: { since: "2026-08-23T00:00:00Z", until: "2026-08-30T00:00:00Z" },
    notice: "untrusted", viewer: null, projects: [], notifications: [], sessions: [], priorReport: null, truncations: [], dataGaps: [],
  };
  registerOrganizer(h.api as any, {
    statePath: join(dir, "state.json"), reportPath: join(dir, "report.md"), organizerDir: dir,
    leasePath: join(dir, "run.sock"), watchDir: () => ({ close() {} }),
    validateLease: async (runId) => runId === "run-1",
    collect: async () => ({ snapshot, text: JSON.stringify(snapshot) }),
  });
  const ctx = context("/organizer");
  h.lifecycle.get("session_start")?.({}, ctx);
  const snapshotTool = h.tools.get("organizer_snapshot");
  const publishTool = h.tools.get("organizer_publish");
  await assert.rejects(() => snapshotTool.execute("t", { run_id: "wrong" }), /lease/);
  await snapshotTool.execute("t", { run_id: "run-1" });
  await assert.rejects(() => snapshotTool.execute("t", { run_id: "run-1" }), /only once/);
  await assert.rejects(() => publishTool.execute("t", { run_id: "run-1", snapshot_id: "stale", report: markdown(450) }), /stale/);
  await assert.rejects(() => publishTool.execute("t", { run_id: "run-1", snapshot_id: "current", report: "bad" }), /Malformed/);
  const result = await publishTool.execute("t", { run_id: "run-1", snapshot_id: "current", report: markdown(450) });
  assert.equal(result.terminate, true);
  assert.match(readFileSync(join(dir, "report.md"), "utf8"), /## Pulse/);
  await assert.rejects(() => publishTool.execute("t", { run_id: "run-1", snapshot_id: "current", report: markdown(450) }), /already published/);
});

test("organizer pane catch-up keys off last success, not newer failed attempt", () => {
  const dir = mkdtempSync(join(tmpdir(), "organizer-catchup-"));
  const statePath = join(dir, "state.json");
  writeState({
    ...emptyState(),
    lastSuccessAt: "2026-08-29T15:00:00Z",
    lastAttemptAt: "2026-08-30T06:59:00Z",
    lastError: "failed",
  }, statePath);
  let delay = -1;
  const h = harness();
  registerOrganizer(h.api as any, {
    statePath, reportPath: join(dir, "report.md"), organizerDir: dir, organizerCwd: "/organizer",
    now: () => Date.parse("2026-08-30T07:00:00Z"),
    setTimer: (_callback, value) => { delay = value; return 1; }, clearTimer: () => {},
    watchDir: () => ({ close() {} }),
  });
  const ctx = context("/organizer");
  h.lifecycle.get("session_start")?.({}, ctx);
  assert.equal(delay, 0);
  h.lifecycle.get("session_shutdown")?.({}, ctx);
});

test("status text includes state and next boundary", () => {
  const text = formatStatus({ version: 1, lastAttemptAt: null, lastSuccessAt: null, snapshot: null, lastPublishedSnapshotId: null, lastError: "x" }, Date.parse("2026-08-30T15:00:00Z"), false);
  assert.match(text, /Last error: x/);
  assert.match(text, /2026-08-30 18:00:00 Europe\/Moscow/);
  assert.equal(formatMoscow(Date.parse("2026-08-30T06:00:00Z")), "2026-08-30 09:00:00 Europe/Moscow");
});
