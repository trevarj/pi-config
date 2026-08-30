import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  BoundaryScheduler,
  MAX_SNAPSHOT_BYTES,
  acquireRunLease,
  assertReadOnlyArgv,
  atomicWrite,
  computeWindow,
  countWords,
  deriveDirtyAt,
  dirtyPaths,
  emptyState,
  githubArgv,
  inferActiveProjects,
  latestMoscowBoundary,
  liveSessionFromFrames,
  nextMoscowBoundary,
  normalizeNotifications,
  parseGithubRemote,
  parseRepositoryResponse,
  parseSessionJsonl,
  publishReport,
  readState,
  reduceSnapshot,
  referencedPullRequests,
  validateReport,
  validateRunLease,
  writeState,
  type Project,
  type SessionSummary,
  type Snapshot,
} from "./core.ts";

const iso = (value: string) => Date.parse(value);

function report(words = 500): string {
  const filler = Array.from({ length: words - 15 }, (_, index) => `w${index}`).join(" ");
  return `# Organizer\n\n## Pulse\n${filler}\n\n## Needs attention\nnone\n\n## Active projects\nnone\n\n## Pi sessions and agents\nnone\n\n## Next three actions\n1. one\n2. two\n3. three\n`;
}

function baseSnapshot(): Snapshot {
  return {
    version: 1,
    id: "snapshot-1",
    timestamp: "2026-08-30T06:00:00.000Z",
    window: { since: "2026-08-23T06:00:00.000Z", until: "2026-08-30T06:00:00.000Z" },
    notice: "untrusted",
    viewer: "trevarj",
    projects: [],
    notifications: [],
    sessions: [],
    priorReport: null,
    truncations: [],
    dataGaps: [],
  };
}

test("Moscow boundaries survive UTC TZ, evening rollover, and next day", () => {
  assert.equal(new Date(latestMoscowBoundary(iso("2026-08-30T05:59:59Z"))).toISOString(), "2026-08-29T15:00:00.000Z");
  assert.equal(new Date(nextMoscowBoundary(iso("2026-08-30T05:59:59Z"))).toISOString(), "2026-08-30T06:00:00.000Z");
  assert.equal(new Date(latestMoscowBoundary(iso("2026-08-30T15:00:00Z"))).toISOString(), "2026-08-30T15:00:00.000Z");
  assert.equal(new Date(nextMoscowBoundary(iso("2026-08-30T15:00:00Z"))).toISOString(), "2026-08-31T06:00:00.000Z");
});

test("scheduler catches up, handles delayed wake, retries once, and avoids overlap", async () => {
  let now = iso("2026-08-30T07:00:00Z");
  let callback: (() => void) | undefined;
  let clears = 0;
  const calls: string[] = [];
  let release!: (ok: boolean) => void;
  const scheduler = new BoundaryScheduler(
    { now: () => now, set: (cb) => { callback = cb; return cb; }, clear: () => { clears += 1; } },
    async (kind) => {
      calls.push(kind);
      if (calls.length === 1) return false;
      return new Promise<boolean>((resolve) => { release = resolve; });
    },
  );
  const failedRecentAttempt = "2026-08-30T06:59:00Z";
  const oldSuccess = "2026-08-29T15:00:00Z";
  assert.ok(Date.parse(failedRecentAttempt) > Date.parse(oldSuccess));
  scheduler.start(oldSuccess);
  assert.equal(scheduler.next(), now); // Failed recent attempt does not suppress catch-up.
  await scheduler.wake();
  assert.deepEqual(calls, ["boundary"]);
  assert.equal(scheduler.next(), now + 15 * 60_000);
  now += 60 * 60_000; // machine slept past retry timer
  const pending = scheduler.wake();
  assert.deepEqual(calls, ["boundary", "retry"]);
  await scheduler.wake();
  assert.equal(calls.length, 2); // overlap suppressed
  release(false);
  await pending;
  assert.equal(new Date(scheduler.next()!).toISOString(), "2026-08-30T15:00:00.000Z");
  callback?.();
  scheduler.stop();
  assert.ok(clears > 0);
});

test("run lease blocks a second runtime, recovers stale socket, validates run id, and cleans up", async () => {
  const dir = mkdtempSync(join(tmpdir(), "organizer-lease-"));
  const path = join(dir, "run.sock");
  writeFileSync(path, "stale");
  const first = await acquireRunLease(dir, path);
  assert.equal(await validateRunLease(first.runId, path), true);
  assert.equal(await validateRunLease("wrong", path), false);
  assert.equal(await validateRunLease(undefined, path), false);
  await assert.rejects(() => acquireRunLease(dir, path), /already in flight/);
  await first.close();
  assert.equal(await validateRunLease(first.runId, path), false);
  const second = await acquireRunLease(dir, path);
  assert.notEqual(second.runId, first.runId);
  await second.close();
  assert.equal(statSync(dir).mode & 0o777, 0o700);
});

test("window starts at last success but never exceeds seven days", () => {
  const now = iso("2026-08-30T12:00:00Z");
  assert.equal(computeWindow(now, null).since, "2026-08-23T12:00:00.000Z");
  assert.equal(computeWindow(now, "2026-08-29T00:00:00Z").since, "2026-08-29T00:00:00.000Z");
  assert.equal(computeWindow(now, "2026-01-01T00:00:00Z").since, "2026-08-23T12:00:00.000Z");
});

test("notifications retain old unread actionable items, dedupe, sort, and cap", () => {
  const raw = Array.from({ length: 120 }, (_, index) => ({
    id: String(index), unread: index % 2 === 0, reason: index === 0 ? "review_requested" : "subscribed",
    updated_at: index === 0 ? "2020-01-01T00:00:00Z" : `2026-08-29T${String(index % 24).padStart(2, "0")}:00:00Z`,
    repository: { full_name: "owner/repo" }, subject: { type: "PullRequest", title: `PR ${index}`, url: `u${index}` },
  }));
  raw.push({ ...raw[1] });
  const kept = normalizeNotifications(raw, iso("2026-08-23T00:00:00Z"));
  assert.equal(kept.length, 100);
  assert.ok(kept.some((item) => item.id === "0"));
  assert.equal(new Set(kept.map((item) => item.id)).size, kept.length);
  assert.equal(kept[0].unread, true);
});

test("notification priority, browser URLs, and retained PR references are explicit", () => {
  const raw = [
    ["generic", "subscribed", true, "2026-08-30T05:00:00Z", 1],
    ["ci", "ci_activity", false, "2026-08-30T01:00:00Z", 2],
    ["assign", "assign", false, "2026-08-29T01:00:00Z", 3],
    ["mention", "team_mention", false, "2026-08-28T01:00:00Z", 4],
    ["review", "review_requested", false, "2026-08-27T01:00:00Z", 42],
  ].map(([id, reason, unread, updated_at, number]) => ({
    id, reason, unread, updated_at,
    repository: { full_name: "Owner/Repo" },
    subject: { type: "PullRequest", title: id, url: `https://api.github.com/repos/Owner/Repo/pulls/${number}` },
  }));
  const notifications = normalizeNotifications(raw, iso("2026-08-23T00:00:00Z"));
  assert.deepEqual(notifications.map((item) => item.id), ["review", "mention", "assign", "ci", "generic"]);
  assert.equal(notifications[0].url, "https://github.com/Owner/Repo/pull/42");
  assert.deepEqual([...referencedPullRequests(notifications).get("owner/repo")!].sort((a, b) => a - b), [1, 2, 3, 4, 42]);
});

test("project inference activates only recent dirty evidence and retains old dirty on otherwise active projects", () => {
  const now = iso("2026-08-30T00:00:00Z");
  const local: Project[] = [{
    name: "repo", path: "/w/repo", github: "o/repo", score: 0, evidence: [], commits: [], pullRequests: [],
    dirty: true, dirtyAt: "2026-08-29T00:00:00Z",
  }];
  const sessions: SessionSummary[] = [{
    id: "s", live: true, cwd: "/w/repo/src", name: null, status: "busy", model: null,
    updatedAt: "2026-08-30T00:00:00Z", userTask: null, assistantOutcome: null, subagents: [],
  }];
  const projects = inferActiveProjects(local, sessions, [], now);
  assert.equal(projects.length, 1);
  assert.deepEqual(projects[0].evidence.sort(), ["live Pi session", "recent dirty worktree"]);
  const stale = { ...local[0], dirtyAt: "2026-08-01T00:00:00Z" };
  assert.equal(inferActiveProjects([stale], [], [], now).length, 0);
  const retained = inferActiveProjects([stale], sessions, [], now)[0];
  assert.equal(retained.dirty, true);
  assert.deepEqual(retained.evidence, ["live Pi session"]);
  const child = { ...stale, path: "/w/umbrella/child" };
  const umbrellaSession = [{ ...sessions[0], cwd: "/w/umbrella" }];
  assert.deepEqual(inferActiveProjects([child], umbrellaSession, [], now)[0].evidence, ["live Pi session"]);
});

test("dirty timestamp uses changed paths and staged index without unsafe path escape", () => {
  const dir = mkdtempSync(join(tmpdir(), "organizer-dirty-"));
  const gitDir = join(dir, ".git");
  mkdirSync(gitDir);
  writeFileSync(join(dir, "changed.txt"), "x");
  writeFileSync(join(gitDir, "index"), "index");
  const old = new Date("2026-08-01T00:00:00Z");
  const recent = new Date("2026-08-29T00:00:00Z");
  utimesSync(join(dir, "changed.txt"), old, old);
  utimesSync(join(gitDir, "index"), recent, recent);
  assert.deepEqual(dirtyPaths("## main\0 M changed.txt\0R  renamed.txt\0old.txt\0"), ["changed.txt", "renamed.txt"]);
  assert.equal(deriveDirtyAt(" M changed.txt\0", dir, ".git"), old.toISOString());
  assert.equal(deriveDirtyAt("M  changed.txt\0", dir, ".git"), recent.toISOString());
  assert.equal(deriveDirtyAt(" M ../../outside\0", dir, ".git"), undefined);
});

test("remote parsing and generated argv stay fixed and read-only", () => {
  assert.equal(parseGithubRemote("git@github.com:owner/repo.git"), "owner/repo");
  assert.equal(parseGithubRemote("https://github.com/owner/repo"), "owner/repo");
  assert.equal(parseGithubRemote("ssh://git@gitlab.com/owner/repo.git"), null);
  for (const argv of [githubArgv("viewer"), githubArgv("notifications"), githubArgv("repository", "owner/repo", "2026-08-01T00:00:00Z")]) {
    assert.equal(assertReadOnlyArgv(argv), true);
  }
  assert.equal(assertReadOnlyArgv(["gh", "api", "graphql", "-f", "query=mutation { deleteProject }"]), false);
  assert.equal(assertReadOnlyArgv(["git", "fetch"]), false);
});

test("repository response carries PR review, check, commit, and path stats without patches", () => {
  const response = { data: { repository: {
    defaultBranchRef: { target: { history: { nodes: [{ oid: "c1", committedDate: "2026-08-29", messageHeadline: "change", authors: { nodes: [{ user: { login: "a" } }] } }] } } },
    pullRequests: { nodes: [{
      number: 7, title: "Review", bodyText: "body", isDraft: true, author: { login: "b" }, updatedAt: "2020-08-29T00:00:00Z", url: "url",
      reviewDecision: "REVIEW_REQUIRED", mergeable: "MERGEABLE", mergeStateStatus: "BLOCKED", additions: 5, deletions: 2, changedFiles: 1,
      reviewRequests: { nodes: [{ requestedReviewer: { login: "a" } }] }, reviews: { nodes: [{ author: { login: "c" }, state: "CHANGES_REQUESTED", submittedAt: "2026-08-29" }] },
      commits: { nodes: [{ commit: { oid: "c2", committedDate: "2026-08-29", messageHeadline: "pr", authors: { nodes: [{ name: "C" }] } } }] },
      files: { nodes: [{ path: "src/a.ts", additions: 5, deletions: 2 }] },
      statusCheckRollup: { contexts: { nodes: [{ name: "test", conclusion: "FAILURE" }] } },
    }] },
  } } };
  assert.equal(parseRepositoryResponse(response, iso("2026-08-23T00:00:00Z")).pullRequests.length, 0);
  const parsed = parseRepositoryResponse(response, iso("2026-08-23T00:00:00Z"), new Set([7]));
  assert.equal(parsed.commits[0].author, "a");
  assert.deepEqual(parsed.pullRequests[0].paths[0], { path: "src/a.ts", additions: 5, deletions: 2 });
  assert.deepEqual(parsed.pullRequests[0].checks[0], { name: "test", state: "FAILURE" });
  assert.equal(parsed.pullRequests[0].isDraft, true);
  assert.equal("patch" in parsed.pullRequests[0], false);
});

test("offline session parser follows active tree and excludes thinking/tool output and unnamed children", () => {
  const jsonl = [
    { type: "session", version: 3, id: "s", timestamp: "2026-08-30T00:00:00Z", cwd: "/w/repo" },
    { type: "message", id: "u1", parentId: null, timestamp: "2026-08-30T00:00:01Z", message: { role: "user", content: "old" } },
    { type: "message", id: "a1", parentId: "u1", timestamp: "2026-08-30T00:00:02Z", message: { role: "assistant", content: [{ type: "thinking", thinking: "secret" }, { type: "text", text: "old answer" }, { type: "toolCall", name: "bash" }] } },
    { type: "message", id: "u2", parentId: "u1", timestamp: "2026-08-30T00:00:03Z", message: { role: "user", content: "active task" } },
    { type: "session_info", id: "n", parentId: "u2", timestamp: "2026-08-30T00:00:04Z", name: "named" },
    { type: "message", id: "a2", parentId: "n", timestamp: "2026-08-30T00:00:05Z", message: { role: "assistant", content: [{ type: "thinking", thinking: "hide" }, { type: "text", text: "active outcome" }] } },
    { type: "message", id: "t", parentId: "a2", timestamp: "2026-08-30T00:00:06Z", message: { role: "toolResult", content: [{ type: "text", text: "raw tool" }] } },
  ].map(JSON.stringify).join("\n");
  const session = parseSessionJsonl(jsonl)!;
  assert.equal(session.userTask, "active task");
  assert.equal(session.assistantOutcome, "active outcome");
  assert.ok(!JSON.stringify(session).includes("secret"));
  assert.ok(!JSON.stringify(session).includes("raw tool"));
  const child = jsonl.replace('"cwd":"/w/repo"', '"cwd":"/w/child","parentSession":"p"').replace('"name":"named"', '"ignored":"named"');
  assert.equal(parseSessionJsonl(child), null);
});

test("compaction retained tail supplies latest task and outcome", () => {
  const jsonl = [
    { type: "session", version: 3, id: "s", timestamp: "2026-08-30T00:00:00Z", cwd: "/w/repo" },
    { type: "message", id: "u1", parentId: null, message: { role: "user", content: "old" } },
    { type: "compaction", id: "c1", parentId: "u1", retainedTail: [
      { role: "user", content: "retained task" },
      { role: "assistant", content: [{ type: "thinking", thinking: "hidden" }, { type: "text", text: "retained outcome" }], provider: "p", model: "m" },
    ] },
  ].map(JSON.stringify).join("\n");
  const session = parseSessionJsonl(jsonl)!;
  assert.equal(session.userTask, "retained task");
  assert.equal(session.assistantOutcome, "retained outcome");
  assert.equal(session.model, "p/m");
  assert.ok(!JSON.stringify(session).includes("hidden"));
});

test("newer unanswered user task clears older assistant outcome", () => {
  const jsonl = [
    { type: "session", version: 3, id: "s", timestamp: "2026-08-30T00:00:00Z", cwd: "/w/repo" },
    { type: "message", id: "u1", parentId: null, message: { role: "user", content: "first" } },
    { type: "message", id: "a1", parentId: "u1", message: { role: "assistant", content: "done" } },
    { type: "message", id: "u2", parentId: "a1", message: { role: "user", content: "unanswered" } },
  ].map(JSON.stringify).join("\n");
  const offline = parseSessionJsonl(jsonl)!;
  assert.equal(offline.userTask, "unanswered");
  assert.equal(offline.assistantOutcome, null);
  const live = liveSessionFromFrames(
    { sessionId: "s", cwd: "/w/repo" },
    [{ message: { role: "assistant", text: "old" } }, { message: { role: "user", text: "new" } }],
  )!;
  assert.equal(live.assistantOutcome, null);
});

test("live session extracts branch-safe text and waiting state only", () => {
  const session = liveSessionFromFrames(
    { sessionId: "s", cwd: "/w/repo", busy: true, waiting: true, model: { provider: "p", id: "m" }, subagents: [{ id: "a" }] },
    [{ timestamp: "2026-08-30", message: { role: "user", text: "task", thinking: "no" } }, { message: { role: "assistant", text: "out", toolOutput: "no" } }],
  )!;
  assert.equal(session.status, "waiting");
  assert.equal(session.model, "p/m");
  assert.equal(session.userTask, "task");
  assert.ok(!JSON.stringify(session).includes("toolOutput"));
});

test("snapshot reduction enforces caps, path markers, and strict sub-50KB output", () => {
  const snapshot = baseSnapshot();
  snapshot.priorReport = "p".repeat(20_000);
  snapshot.notifications = Array.from({ length: 120 }, (_, index) => ({ id: String(index), repository: "o/r", reason: "x", unread: false, updatedAt: String(index), type: "Issue", title: "t".repeat(500), url: "u" }));
  snapshot.sessions = Array.from({ length: 25 }, (_, index) => ({ id: String(index), live: false, cwd: `/w/${index}`, name: null, status: "offline", model: null, updatedAt: String(index), userTask: "u".repeat(2000), assistantOutcome: "a".repeat(2000), subagents: [] }));
  snapshot.projects = Array.from({ length: 22 }, (_, index) => ({
    name: `p${index}`, path: `/w/p${index}`, github: `o/p${index}`, score: 100 - index, evidence: ["recent"], commits: Array.from({ length: 10 }, (__, c) => ({ oid: `${index}-${c}`, date: String(c), author: "a", subject: "s".repeat(300) })),
    pullRequests: [{ number: index, title: "t", body: "b".repeat(2000), isDraft: false, author: "a", updatedAt: "x", url: "u", reviewDecision: null, reviewRequests: [], mergeable: null, mergeStateStatus: null, checks: [], reviews: [], commits: [], paths: Array.from({ length: 40 }, (__, p) => ({ path: `src/${p}/${"x".repeat(300)}`, additions: p, deletions: p })), additions: 1, deletions: 1, changedFiles: 40 }],
  }));
  const reduced = reduceSnapshot(snapshot);
  const totalCommits = reduced.snapshot.projects.reduce((total, project) =>
    total + project.commits.length + project.pullRequests.reduce((sum, pr) => sum + pr.commits.length, 0), 0);
  assert.ok(Buffer.byteLength(reduced.text) < MAX_SNAPSHOT_BYTES);
  assert.ok(totalCommits <= 100);
  assert.ok(reduced.snapshot.projects.length <= 20);
  assert.ok(reduced.snapshot.sessions.length <= 20);
  assert.ok(reduced.snapshot.notifications.length <= 100);
  assert.ok(reduced.snapshot.truncations.some((marker) => marker.includes("Changed paths")));
});

test("error-heavy snapshots stay below 50KB and mark omitted data gaps", () => {
  const snapshot = baseSnapshot();
  snapshot.dataGaps = Array.from({ length: 500 }, (_, index) => `failure ${index}: ${"x".repeat(2000)}`);
  const reduced = reduceSnapshot(snapshot);
  assert.ok(Buffer.byteLength(reduced.text) < MAX_SNAPSHOT_BYTES);
  assert.ok(reduced.snapshot.dataGaps.length < 500);
  assert.ok(reduced.snapshot.truncations.some((marker) => marker.includes("Data gaps") || marker.includes("data gaps")));
});

test("publication validates shape and word cap, uses 0600 files, preserves old report, and rejects stale/replay", () => {
  const dir = mkdtempSync(join(tmpdir(), "organizer-publish-"));
  const paths = { report: join(dir, "organizer", "report.md"), state: join(dir, "organizer", "state.json") };
  atomicWrite(paths.report, "old\n");
  const snapshotA = { id: "a", timestamp: "2026-08-30T00:00:00Z" };
  const snapshotB = { id: "b", timestamp: "2026-08-30T01:00:00Z" };
  writeState({ ...emptyState(), snapshot: snapshotA }, paths.state);
  assert.throws(() => publishReport("bad", snapshotA, paths));
  assert.equal(readFileSync(paths.report, "utf8"), "old\n");
  writeState({ ...readState(paths.state), snapshot: snapshotB }, paths.state);
  const clean = validateReport(report(500));
  assert.ok(countWords(clean) <= 650);
  assert.throws(() => publishReport(clean, snapshotA, paths), /stale/);
  assert.equal(readFileSync(paths.report, "utf8"), "old\n");
  publishReport(clean, snapshotB, paths);
  const published = readFileSync(paths.report, "utf8");
  assert.equal(readState(paths.state).lastPublishedSnapshotId, "b");
  assert.throws(() => publishReport(clean, snapshotB, paths), /already published/);
  assert.equal(readFileSync(paths.report, "utf8"), published);
  assert.equal(statSync(paths.report).mode & 0o777, 0o600);
  assert.equal(statSync(paths.state).mode & 0o777, 0o600);
  assert.throws(() => validateReport(report(700)), /650/);
});
