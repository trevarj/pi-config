import assert from "node:assert/strict";
import { chmodSync, lstatSync, mkdirSync, symlinkSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { classifyGitCommand, rewriteSignedPathCommit } from "../child.ts";
import { buildDelegatedContext, redactSecrets, safeConversation } from "../context.ts";
import {
  acquireLease,
  conflictingLease,
  dirtyConflict,
  normalizeLeasePath,
  normalizeToolPath,
  parseGitStatusZ,
  pathsOverlap,
} from "../leases.ts";
import {
  buildAtomicPlan,
  createEmptyState,
  dependenciesReady,
  resolveModelQuery,
  reviewFingerprint,
  reviewLoopGuard,
  validateDag,
} from "../scheduler.ts";
import { markTerminal, pruneTerminalStates, readState, recoverState, statePath, writeStateAtomic } from "../state.ts";
import { MAX_AGENTS, MAX_TASKS, type AgentRecord, type TaskRecord } from "../types.ts";

const models = [
  { provider: "anthropic", id: "claude-sonnet", name: "Sonnet" },
  { provider: "openai", id: "gpt-5", name: "GPT 5" },
  { provider: "other", id: "gpt-5-mini", name: "GPT mini" },
];

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "t", title: "task", prompt: "do it", kind: "implementer", dependsOn: [], paths: ["src"],
    allowDirty: false, mutating: true, autoReview: true, contextMode: "bounded", gitAuthority: "none",
    status: "queued", phase: "implement", attempts: 0, retries: 0, turns: 0,
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", reviewFingerprints: [],
    maxTurns: 50, timeoutMs: 60 * 60 * 1000,
    ...overrides,
  };
}

function agent(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "a", name: "a", kind: "implementer", model: models[0], thinking: "high",
    instructions: "", lifetime: "team", status: "queued",
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", ...overrides,
  };
}

test("model resolver inherits or requires exact/unique matches without fallback", () => {
  assert.equal(resolveModelQuery(undefined, models, models[0]).id, "claude-sonnet");
  assert.equal(resolveModelQuery("openai/gpt-5", models, models[0]).provider, "openai");
  assert.equal(resolveModelQuery("Sonnet", models, models[0]).id, "claude-sonnet");
  assert.equal(resolveModelQuery("mini", models, models[0]).id, "gpt-5-mini");
  assert.throws(() => resolveModelQuery("gpt", models, models[0]), /not unique/);
  assert.throws(() => resolveModelQuery("missing", models, models[0]), /No fallback/);
  assert.throws(() => resolveModelQuery(undefined, models, undefined), /no active model/);
});

test("atomic plan validates DAG, roles, defaults, and leaves state unchanged on failure", () => {
  const state = createEmptyState("s", "/repo", "/repo");
  const plan = buildAtomicPlan({
    state,
    agents: [{ name: "worker", kind: "implementer" }, { name: "reader", kind: "explorer", model: "openai/gpt-5" }],
    tasks: [
      { id: "write", prompt: "write", agent: "worker", mutating: true },
      { id: "read", prompt: "read", agent: "reader", dependsOn: ["write"] },
    ],
    models,
    parentModel: models[0],
    parentThinking: "high",
  });
  assert.deepEqual(plan.tasks[0].paths, ["."]);
  assert.equal(plan.tasks[0].autoReview, true);
  assert.equal(plan.tasks[1].dependsOn[0], "write");
  assert.equal(dependenciesReady(plan.tasks[1], [plan.tasks[0], plan.tasks[1]]), false);
  plan.tasks[0].status = "completed";
  assert.equal(dependenciesReady(plan.tasks[1], plan.tasks), true);
  assert.deepEqual(state.agents, []);
  assert.throws(() => buildAtomicPlan({
    state, agents: [{ name: "reader", kind: "explorer" }],
    tasks: [{ id: "bad", prompt: "mutate", agent: "reader", kind: "implementer", mutating: true }],
    models, parentModel: models[0], parentThinking: "high",
  }), /does not match/);
  assert.deepEqual(state.tasks, []);
});

test("DAG and hard caps reject cycles and overflow deterministically", () => {
  assert.throws(() => validateDag([
    { id: "a", dependsOn: ["b"] }, { id: "b", dependsOn: ["a"] },
  ]), /cycle/);
  assert.throws(() => validateDag([{ id: "a", dependsOn: ["missing"] }]), /unknown dependency/);
  const fullAgents = createEmptyState("s", "/repo", "/repo");
  fullAgents.agents = Array.from({ length: MAX_AGENTS }, (_, index) => agent({ id: `a${index}`, name: `a${index}` }));
  assert.throws(() => buildAtomicPlan({
    state: fullAgents, agents: [{ name: "extra", kind: "general" }], tasks: [{ prompt: "x" }],
    models, parentModel: models[0], parentThinking: "off",
  }), /Agent cap/);
  const fullTasks = createEmptyState("s", "/repo", "/repo");
  fullTasks.agents = [agent()];
  fullTasks.tasks = Array.from({ length: MAX_TASKS }, (_, index) => task({ id: `t${index}`, mutating: false, autoReview: false, paths: [] }));
  assert.throws(() => buildAtomicPlan({
    state: fullTasks, agents: [], tasks: [{ prompt: "x", agent: "a" }], models,
    parentModel: models[0], parentThinking: "off",
  }), /Task cap/);
});

test("path leases normalize prefixes, reject overlap/dirty paths, symlinks, and .git", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-agents-lease-"));
  mkdirSync(join(root, "src"));
  symlinkSync(join(root, "src"), join(root, "link"));
  assert.equal(normalizeLeasePath(root, "src/"), "src");
  assert.equal(normalizeLeasePath(root, "."), ".");
  assert.throws(() => normalizeLeasePath(root, "../outside"), /escapes/);
  assert.throws(() => normalizeLeasePath(root, ".git/config"), /.git/);
  assert.throws(() => normalizeLeasePath(root, "link/file"), /symlink/);
  assert.equal(normalizeToolPath(root, join(root, "src"), "@../src/file.ts"), "src/file.ts");
  assert.throws(() => normalizeToolPath(root, join(root, "src"), "@../../outside"), /escapes/);
  assert.throws(() => normalizeToolPath(root, join(root, "src"), "~/.pi/state"), /escapes/);
  assert.equal(pathsOverlap("src", "src/lib/a.ts"), true);
  assert.equal(pathsOverlap("src", "test"), false);
  const lease = { taskId: "one", agentId: "a", paths: ["src"], acquiredAt: "now" };
  assert.equal(conflictingLease(["src/lib"], [lease])?.taskId, "one");
  assert.equal(dirtyConflict(["src"], ["src/a.ts"]), "src/a.ts");
  assert.throws(() => acquireLease([], lease, ["src/a.ts"], false), /allowDirty/);
  assert.deepEqual(acquireLease([], lease, ["src/a.ts"], true), [lease]);
  assert.deepEqual(parseGitStatusZ(" M src/a.ts\0R  next.ts\0old.ts\0?? new.ts\0"), ["src/a.ts", "next.ts", "old.ts", "new.ts"]);
});

test("context excludes thinking/tool bulk, redacts secrets, uses compaction and stays bounded", () => {
  const branch = [
    { type: "message", message: { role: "user", content: "token=sk-abcdefghijklmnopqrstuvwxyz" } },
    { type: "message", message: { role: "assistant", content: [
      { type: "thinking", thinking: "private chain" },
      { type: "toolCall", name: "read", arguments: { content: "bulk" } },
      { type: "text", text: "safe answer" },
    ] } },
    { type: "message", message: { role: "toolResult", content: [{ type: "text", text: "huge tool output" }] } },
    { type: "compaction", summary: "summary password=hunter2" },
  ];
  const safe = safeConversation(branch);
  assert.equal(safe.messages.length, 2);
  assert.ok(!JSON.stringify(safe).includes("private chain"));
  assert.ok(!JSON.stringify(safe).includes("huge tool"));
  assert.ok(redactSecrets("Bearer abcdefghijklmnop").includes("[redacted]"));
  const output = buildDelegatedContext({ task: "do work", branch, gitSummary: "M src/a", maxBytes: 220 });
  assert.ok(Buffer.byteLength(output) <= 220);
  assert.ok(output.includes("Delegated task"));
  assert.ok(!output.includes("hunter2"));
  const fresh = buildDelegatedContext({ task: "fresh", branch, gitSummary: "clean", mode: "fresh" });
  assert.ok(!fresh.includes("Recent conversation"));
  assert.ok(!fresh.includes("compaction"));
});

test("Git guard classifies authority-sensitive operations and rewrites commits signed/path-limited", () => {
  assert.equal(classifyGitCommand("git status"), "none");
  assert.equal(classifyGitCommand("git commit -m 'done'"), "commit");
  assert.equal(classifyGitCommand("git add src"), "stage");
  assert.equal(classifyGitCommand("git push origin main"), "push");
  assert.equal(classifyGitCommand("sudo /usr/bin/git push origin main"), "push");
  assert.equal(classifyGitCommand("bash -c 'git commit -m wrapped'"), "commit");
  assert.equal(classifyGitCommand("git switch feature"), "branch");
  assert.equal(classifyGitCommand("git update-ref refs/heads/main deadbeef"), "branch");
  assert.equal(classifyGitCommand("git unknown-mutator"), "branch");
  assert.equal(rewriteSignedPathCommit("git commit -m 'done'", ["src", "a'b.ts"]), "git commit -S '-m' 'done' --only -- 'src' 'a'\"'\"'b.ts'");
  assert.throws(() => rewriteSignedPathCommit("git commit outside.ts -m x", ["src"]), /cannot be made path-limited/);
  assert.throws(() => rewriteSignedPathCommit("git commit -m x && git push", ["src"]), /Complex/);
});

test("review guards stop unchanged diffs and repeated material findings", () => {
  const first = reviewLoopGuard(task(), { decision: "changes_requested", summary: "Null check missing at line 42" }, "hash-1");
  assert.equal(first.stop, false);
  const unchanged = reviewLoopGuard(task({ preFixDiffHash: "hash-1" }), { decision: "changes_requested", summary: "new" }, "hash-1");
  assert.match(unchanged.reason ?? "", /unchanged diff/);
  const fingerprint = reviewFingerprint("Null check missing at line 99");
  const repeated = reviewLoopGuard(task({ reviewFingerprints: [fingerprint] }), { decision: "changes_requested", summary: "Null check missing at line 1" }, "hash-2");
  assert.match(repeated.reason ?? "", /repeated/);
  assert.equal(reviewLoopGuard(task(), { decision: "approved", summary: "ok" }, "hash").stop, false);
});

test("state writes atomically as 0600, recovers active work paused, and prunes old terminal teams", () => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-agents-state-"));
  const path = statePath("parent", agentDir);
  const state = createEmptyState("parent", "/repo", "/repo", "2026-01-01T00:00:00Z");
  state.agents = [agent({ status: "running" })];
  state.tasks = [task({ status: "running" })];
  writeStateAtomic(path, state);
  assert.equal(lstatSync(path).mode & 0o777, 0o600);
  const loaded = readState(path)!;
  const recovered = recoverState(loaded, "2026-01-02T00:00:00Z");
  assert.equal(recovered.agents[0].status, "paused");
  assert.equal(recovered.tasks[0].status, "paused");
  state.leases = [{ taskId: "t", agentId: "a", paths: ["src"], acquiredAt: "now" }];
  assert.equal(recoverState(state).leases.length, 1);
  recovered.tasks[0].status = "completed";
  recovered.agents[0].status = "hibernated";
  const terminal = markTerminal(recovered, "2020-01-01T00:00:00Z");
  writeStateAtomic(path, terminal);
  chmodSync(path, 0o600);
  utimesSync(path, new Date(0), new Date(0));
  assert.deepEqual(pruneTerminalStates(agentDir, Date.parse("2020-02-15T00:00:00Z")), ["parent"]);
});
