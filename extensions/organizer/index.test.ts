import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { emptyState, readState, writeState, type RunLease, type Snapshot } from "./core.ts";
import { ORGANIZER_TOOLS, formatMoscow, formatStatus, registerOrganizer, type OrganizerReviewScreen } from "./index.ts";

function markdown(words = 500): string {
  const filler = Array.from({ length: words }, (_, index) => `word${index}`).join(" ");
  return `# Organizer\n\n## Pulse\n${filler}\n\n## Needs attention\nnone\n\n## Active projects\nnone\n\n## Pi sessions and agents\nnone\n\n## Next three actions\n1. one\n2. two\n3. three`;
}

function harness(activeTools: string[] = ["read", "bash", ...ORGANIZER_TOOLS]) {
  const lifecycle = new Map<string, (event: any, ctx: any) => unknown>();
  const commands = new Map<string, any>();
  const tools = new Map<string, any>();
  const active = [...activeTools];
  const api: any = {
    exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
    on: (event: string, handler: (event: any, ctx: any) => unknown) => lifecycle.set(event, handler),
    registerCommand: (name: string, options: any) => commands.set(name, options),
    registerTool: (tool: any) => tools.set(tool.name, tool),
    getActiveTools: () => [...active],
    setActiveTools: (names: string[]) => { active.splice(0, active.length, ...names); },
  };
  return { lifecycle, commands, tools, active, api };
}

function context(cwd: string, notices: unknown[][] = []) {
  return {
    cwd,
    mode: "tui",
    ui: {
      notify: (...args: unknown[]) => notices.push(args),
      setStatus() {},
    },
  };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
const lease = (runId: string, closed: string[] = []): RunLease => ({ runId, async close() { closed.push(runId); } });

test("ordinary sessions deactivate internal tools; organizer child keeps only both", () => {
  const dir = mkdtempSync(join(tmpdir(), "organizer-mode-"));
  const ordinary = harness();
  registerOrganizer(ordinary.api, { statePath: join(dir, "state.json"), reportPath: join(dir, "report.md"), organizerDir: dir, watchDir: () => ({ close() {} }) });
  ordinary.lifecycle.get("session_start")?.({}, context("/workspace/project"));
  assert.deepEqual(ordinary.active, ["read", "bash"]);

  const child = harness([...ORGANIZER_TOOLS]);
  registerOrganizer(child.api, { statePath: join(dir, "child-state.json"), reportPath: join(dir, "child-report.md"), organizerDir: dir, watchDir: () => ({ close() {} }) });
  child.lifecycle.get("session_start")?.({}, context("/workspace/.pi-organizer"));
  assert.deepEqual(child.active, [...ORGANIZER_TOOLS]);
});

test("commands render read-only Markdown report and status, reject outside status, and clean watcher", async () => {
  const dir = mkdtempSync(join(tmpdir(), "organizer-command2-"));
  const h = harness();
  const notices: unknown[][] = [];
  const reviews: OrganizerReviewScreen[] = [];
  let closed = 0;
  registerOrganizer(h.api, {
    statePath: join(dir, "state.json"), reportPath: join(dir, "report.md"), organizerDir: dir,
    organizerCwd: "/organizer", watchDir: () => ({ close: () => { closed += 1; } }),
    review: async (_ctx, screen) => { reviews.push(screen); },
  });
  const ctx = context("/project", notices);
  h.lifecycle.get("session_start")?.({}, ctx);
  await h.commands.get("organizer").handler("show", ctx);
  assert.match(reviews[0].content, /No report/);
  assert.deepEqual(reviews[0].format, { kind: "markdown", renderLatex: false, renderMermaid: false });
  assert.equal("confirm" in reviews[0], false);
  await h.commands.get("organizer").handler("status", ctx);
  assert.match(String(notices.at(-1)?.[0]), /organizer pane/);
  await h.commands.get("organizer").handler("status", context("/organizer"));
  assert.match(reviews[1].content, /^# Organizer status/m);
  assert.equal("confirm" in reviews[1], false);
  h.lifecycle.get("session_shutdown")?.({}, ctx);
  assert.equal(closed, 1);
});

test("report watcher debounces routine publication without a toast and stops on shutdown", () => {
  const dir = mkdtempSync(join(tmpdir(), "organizer-watch-"));
  const statePath = join(dir, "state.json");
  const h = harness();
  const notices: unknown[][] = [];
  let watched: (() => void) | undefined;
  let timer: (() => void) | undefined;
  let clears = 0;
  let closed = 0;
  registerOrganizer(h.api, {
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
  assert.deepEqual(notices, []);
  assert.ok(clears >= 1);
  h.lifecycle.get("session_shutdown")?.({}, ctx);
  assert.equal(closed, 1);
});

test("refresh uses bounded direct Pi child and requires persisted publication", async () => {
  const dir = mkdtempSync(join(tmpdir(), "organizer-child-"));
  const statePath = join(dir, "state.json");
  const h = harness();
  const notices: unknown[][] = [];
  const closed: string[] = [];
  const organizerCwd = join(dir, "cwd");
  let invocation: { command: string; args: string[]; options: any } | undefined;
  registerOrganizer(h.api, {
    statePath, reportPath: join(dir, "report.md"), organizerDir: dir, organizerCwd,
    watchDir: () => ({ close() {} }), acquireLease: async () => lease("run-1", closed),
    resolvePi: async (args) => ({ command: "/nix/store/node/bin/node", args }),
  });
  h.api.exec = async (command: string, args: string[], options: any) => {
    invocation = { command, args, options };
    writeState({ ...readState(statePath), snapshot: { id: "snap-1", timestamp: "now" }, lastSuccessAt: "later", lastPublishedSnapshotId: "snap-1", lastError: null }, statePath);
    return { stdout: "ignored", stderr: "", code: 0, killed: false };
  };
  const ctx = context("/project", notices);
  h.lifecycle.get("session_start")?.({}, ctx);
  await h.commands.get("organizer").handler("refresh", ctx);
  await tick();
  await tick();
  assert.equal(invocation?.command, "/nix/store/node/bin/node");
  assert.equal(invocation?.options.cwd, organizerCwd);
  assert.equal(invocation?.options.timeout, 180_000);
  assert.ok(invocation?.options.signal instanceof AbortSignal);
  const args = invocation!.args;
  assert.deepEqual(args.slice(0, 9), ["--print", "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-builtin-tools", "--tools"]);
  assert.equal(args[9], ORGANIZER_TOOLS.join(","));
  assert.ok(args.includes("--extension"));
  assert.ok(args.includes("--model") && args[args.indexOf("--model") + 1] === "openai-codex/gpt-5.6-luna");
  assert.ok(args.includes("--thinking") && args[args.indexOf("--thinking") + 1] === "high");
  assert.match(args[args.indexOf("--system-prompt") + 1], /untrusted data/);
  assert.equal(readState(statePath).lastError, null);
  assert.deepEqual(closed, ["run-1"]);
});

test("child failure records bounded error and permits another refresh", async () => {
  const dir = mkdtempSync(join(tmpdir(), "organizer-child-fail-"));
  const statePath = join(dir, "state.json");
  const h = harness();
  let run = 0;
  let attempts = 0;
  registerOrganizer(h.api, {
    statePath, reportPath: join(dir, "report.md"), organizerDir: dir, organizerCwd: join(dir, "cwd"),
    watchDir: () => ({ close() {} }), acquireLease: async () => lease(`run-${++run}`),
    resolvePi: async (args) => ({ command: "pi", args }),
  });
  h.api.exec = async () => { attempts += 1; throw new Error("failed\nAuthorization: secret"); };
  const ctx = context("/project");
  h.lifecycle.get("session_start")?.({}, ctx);
  await h.commands.get("organizer").handler("refresh", ctx);
  await tick();
  await h.commands.get("organizer").handler("refresh", ctx);
  await tick();
  assert.equal(attempts, 2);
  assert.ok(!readState(statePath).lastError?.includes("secret"));
});

test("shutdown aborts child, closes lease, and suppresses stale completion", async () => {
  const dir = mkdtempSync(join(tmpdir(), "organizer-shutdown-"));
  const closed: string[] = [];
  const h = harness();
  let signal: AbortSignal | undefined;
  registerOrganizer(h.api, {
    statePath: join(dir, "state.json"), reportPath: join(dir, "report.md"), organizerDir: dir, organizerCwd: join(dir, "cwd"),
    watchDir: () => ({ close() {} }), acquireLease: async () => lease("run-1", closed),
    resolvePi: async (args) => ({ command: "pi", args }),
  });
  h.api.exec = async (_command: string, _args: string[], options: any) => { signal = options.signal; return new Promise(() => {}); };
  const ctx = context("/project");
  h.lifecycle.get("session_start")?.({}, ctx);
  await h.commands.get("organizer").handler("refresh", ctx);
  await tick();
  h.lifecycle.get("session_shutdown")?.({}, ctx);
  assert.equal(signal?.aborted, true);
  assert.deepEqual(closed, ["run-1"]);
});

test("shutdown during lease acquisition closes stale lease without starting child", async () => {
  const dir = mkdtempSync(join(tmpdir(), "organizer-acquire-shutdown-"));
  const closed: string[] = [];
  const h = harness();
  let resolveLease!: (value: RunLease) => void;
  const acquired = new Promise<RunLease>((resolve) => { resolveLease = resolve; });
  let executions = 0;
  registerOrganizer(h.api, {
    statePath: join(dir, "state.json"),
    reportPath: join(dir, "report.md"),
    organizerDir: dir,
    organizerCwd: join(dir, "cwd"),
    watchDir: () => ({ close() {} }),
    acquireLease: async () => acquired,
    resolvePi: async (args) => ({ command: "pi", args }),
  });
  h.api.exec = async () => {
    executions += 1;
    return { stdout: "", stderr: "", code: 0, killed: false };
  };
  const ctx = context("/project");
  h.lifecycle.get("session_start")?.({}, ctx);
  await h.commands.get("organizer").handler("refresh", ctx);
  await tick();
  h.lifecycle.get("session_shutdown")?.({}, ctx);
  resolveLease(lease("run-1", closed));
  await tick();
  await tick();
  assert.equal(executions, 0);
  assert.deepEqual(closed, ["run-1"]);
});

test("snapshot is single-use; publish rejects stale/replay and terminates after valid atomic publish", async () => {
  const dir = mkdtempSync(join(tmpdir(), "organizer-tools-"));
  const h = harness([...ORGANIZER_TOOLS]);
  const snapshot: Snapshot = {
    version: 1, id: "current", timestamp: "2026-08-30T00:00:00Z",
    window: { since: "2026-08-23T00:00:00Z", until: "2026-08-30T00:00:00Z" },
    notice: "untrusted", viewer: null, projects: [], notifications: [], sessions: [], priorReport: null, truncations: [], dataGaps: [],
  };
  registerOrganizer(h.api, {
    statePath: join(dir, "state.json"), reportPath: join(dir, "report.md"), organizerDir: dir,
    leasePath: join(dir, "run.sock"), watchDir: () => ({ close() {} }),
    validateLease: async (runId) => runId === "run-1", collect: async () => ({ snapshot, text: JSON.stringify(snapshot) }),
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
  writeState({ ...emptyState(), lastSuccessAt: "2026-08-29T15:00:00Z", lastAttemptAt: "2026-08-30T06:59:00Z", lastError: "failed" }, statePath);
  let delay = -1;
  const h = harness();
  registerOrganizer(h.api, {
    statePath, reportPath: join(dir, "report.md"), organizerDir: dir, organizerCwd: "/organizer",
    now: () => Date.parse("2026-08-30T07:00:00Z"), setTimer: (_callback, value) => { delay = value; return 1; }, clearTimer: () => {},
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
  assert.equal(formatMoscow(Date.parse("2026-08-30T06:00:00Z")), "2026-08-30 09:00:00 Europe\/Moscow");
});
