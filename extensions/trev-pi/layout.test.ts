import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  buildFooterRows,
  compactNumber,
  compactPluginStatus,
  contextTelemetry,
  fitAdaptiveSegments,
  oneLine,
  promptCacheTelemetry,
  shouldRefreshGit,
  splitResourceCommands,
  StartupDashboard,
  stripAnsi,
  type FooterView,
  type HeaderData,
} from "./presentation.ts";
import {
  CoalescingJob,
  parseGitHubNotificationCount,
  parseGitStatusV2,
  parsePullRequest,
  TelemetryCollector,
  type TelemetrySnapshot,
} from "./state.ts";
import {
  AnimationClock,
  partialProgress,
  setupToolRenderers,
  ToolActivityController,
  toolSubject,
  toolSummary,
} from "./tools.ts";

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
  strikethrough: (text: string) => text,
} as any;

function telemetry(): TelemetrySnapshot {
  return {
    git: {
      kind: "ready",
      updatedAt: 1,
      value: { branch: "main", ahead: 2, behind: 1, staged: 3, unstaged: 4, untracked: 5, conflicted: 1, changed: 13 },
    },
    pullRequest: {
      kind: "ready",
      updatedAt: 1,
      value: {
        number: 42,
        isDraft: false,
        url: "https://github.com/o/r/pull/42",
        state: "OPEN",
        reviewDecision: "APPROVED",
        checks: { total: 4, success: 3, pending: 1, failure: 0, neutral: 0 },
      },
    },
    notifications: { kind: "ready", value: 7, updatedAt: 1 },
    health: {
      git: { id: "git", command: "git status", refresh: "30s", requests: 1, runs: 1, coalesced: 0, inFlight: false, queued: false },
      "pull-request": { id: "pull-request", command: "gh pr view", refresh: "60s", requests: 1, runs: 1, coalesced: 0, inFlight: false, queued: false },
      notifications: { id: "notifications", command: "gh api notifications", refresh: "5m", requests: 1, runs: 1, coalesced: 0, inFlight: false, queued: false },
    },
  };
}

test("parses porcelain-v2 branch metadata and rich worktree counters", () => {
  const parsed = parseGitStatusV2([
    "# branch.oid 0123456789abcdef",
    "# branch.head feature/wide",
    "# branch.upstream origin/feature/wide",
    "# branch.ab +2 -3",
    "1 M. N... 100644 100644 100644 a b staged.ts",
    "1 .M N... 100644 100644 100644 a b modified.ts",
    "2 R. N... 100644 100644 100644 a b R100 renamed.ts\told.ts",
    "u UU N... 100644 100644 100644 100644 a b c conflict.ts",
    "? new.ts",
    "",
  ].join("\n"));
  assert.deepEqual(parsed, {
    branch: "feature/wide",
    oid: "0123456789abcdef",
    upstream: "origin/feature/wide",
    ahead: 2,
    behind: 3,
    staged: 2,
    unstaged: 1,
    untracked: 1,
    conflicted: 1,
    changed: 5,
  });
});

test("parses bounded pull request checks and notification pages", () => {
  const pr = parsePullRequest(JSON.stringify({
    number: 9,
    isDraft: true,
    url: "https://github.com/o/r/pull/9",
    state: "OPEN",
    closedAt: null,
    mergedAt: null,
    reviewDecision: "CHANGES_REQUESTED",
    statusCheckRollup: [
      { status: "COMPLETED", conclusion: "SUCCESS" },
      { status: "IN_PROGRESS", conclusion: null },
      { status: "COMPLETED", conclusion: "FAILURE" },
      { status: "COMPLETED", conclusion: "SKIPPED" },
    ],
  }));
  assert.deepEqual(pr.checks, { total: 4, success: 1, pending: 1, failure: 1, neutral: 1 });
  assert.equal(parseGitHubNotificationCount("50\n12\n"), 62);
  assert.throws(() => parseGitHubNotificationCount(""), /Invalid/);
});

test("sanitizes values and formats resource, cache, and workflow telemetry", () => {
  assert.equal(oneLine("one\x1b]0;bad\x07\n\ttwo\u202e"), "one two");
  assert.equal(stripAnsi("\x1b[31mred\x1b[0m"), "red");
  assert.equal(compactNumber(1_500), "1.5k");
  assert.equal(contextTelemetry(42_000, 1_000_000), "42k/1M");
  assert.equal(compactPluginStatus("goal", "active 12m · automatic 3/25"), "goal 3/25");
  assert.deepEqual(splitResourceCommands([
    { name: "skill:rg-search", source: "skill" },
    { name: "plan", source: "extension" },
    { name: "review", source: "prompt" },
  ]), { skills: ["rg-search"], commands: ["/plan"], prompts: ["/review"] });
  const message = (read: number, write: number) => ({
    role: "assistant", provider: "p", model: "m", usage: { cacheRead: read, cacheWrite: write },
  });
  assert.deepEqual(promptCacheTelemetry([message(84_000, 12_000)], "p", "m"), { text: "84kr/12kw", empty: false });
  assert.equal(shouldRefreshGit("bash", { command: "echo digit" }, false), false);
  assert.equal(shouldRefreshGit("bash", { command: "git switch next" }, false), true);
});

test("priority fitting omits complete segments instead of truncating them", () => {
  const segments = [
    { id: "low", variants: ["low-long", "lo"], priority: 1 },
    { id: "high", variants: ["high-value", "hi"], priority: 10 },
  ];
  assert.equal(fitAdaptiveSegments(segments, 30), "low-long · high-value");
  assert.equal(fitAdaptiveSegments(segments, 8), "lo · hi");
  assert.equal(fitAdaptiveSegments(segments, 1), "");
});

test("footer is exactly two bounded rows at required widths", () => {
  const view: FooterView = {
    now: 12_000,
    activity: "active",
    activitySince: 1_000,
    frame: "⠋",
    provider: "provider\x1b]0;bad\x07",
    model: `模型-${"very-long-".repeat(20)}`,
    thinking: "xhigh",
    context: "123k/1M",
    cache: { text: "84kr/12kw", empty: false },
    providerUsage: "80% 5h · 20% week",
    queued: true,
    project: `工程-${"long-".repeat(20)}`,
    session: `会話-${"session-".repeat(20)}`,
    telemetry: telemetry(),
    statuses: [["usage", "80% 5h"], ["goal", "active · automatic 3/25"], ["work-mode", "mode guided"]],
  };
  for (const width of [0, 1, 20, 40, 80, 120, 200]) {
    const rows = buildFooterRows(view, width, theme);
    assert.equal(rows.length, 2, `width ${width}`);
    for (const row of rows) {
      assert.ok(visibleWidth(row) <= Math.max(0, width), `width ${width}: ${row}`);
      assert.doesNotMatch(row, /\x1b\]0;/u);
    }
  }
});

test("startup dashboard remains width-safe with ANSI, wide, control, and long inventories", () => {
  const data: HeaderData = {
    project: `工程-${"long-".repeat(20)}\x1b]0;bad\x07`,
    cwd: `/home/test/${"deep/".repeat(20)}`,
    session: `会話-${"long-".repeat(20)}`,
    sessionId: "session-id-1234567890",
    provider: "provider",
    model: `模型-${"model-".repeat(20)}`,
    thinking: "xhigh",
    trusted: false,
    telemetry: telemetry(),
    skills: Array.from({ length: 12 }, (_, index) => `skill-${index}-界`),
    commands: Array.from({ length: 12 }, (_, index) => `/command-${index}`),
    prompts: ["/review"],
    tools: ["read", "bash", "grep"],
  };
  const dashboard = new StartupDashboard(theme, { getKeys: () => ["ctrl+o"] } as any, () => data, () => {});
  dashboard.setExpanded(true);
  for (const width of [0, 1, 20, 40, 80, 120, 200]) {
    for (const line of dashboard.render(width)) {
      assert.ok(visibleWidth(line) <= width, `width ${width}: ${line}`);
      assert.doesNotMatch(line, /\x1b\]0;/u);
    }
  }
});

test("tool subjects, progress, and final tones distinguish neutral and warning", () => {
  assert.equal(toolSubject("read", { path: "src/a.ts", offset: 5, limit: 3 }), "src/a.ts:5-7");
  assert.equal(toolSubject("bash", { command: "echo one\necho two\x1b]0;x\x07" }), "echo one echo two");
  assert.deepEqual(toolSummary("grep", {}, { content: [{ type: "text", text: "No matches found" }] }, false), { text: "no matches", tone: "neutral" });
  assert.deepEqual(toolSummary("find", {}, { content: [{ type: "text", text: "No files found matching pattern" }] }, false), { text: "0 files", tone: "neutral" });
  assert.deepEqual(toolSummary("ls", {}, { content: [{ type: "text", text: "(empty directory)" }] }, false), { text: "0 entries", tone: "neutral" });
  assert.deepEqual(toolSummary("bash", {}, { content: [{ type: "text", text: "Command timed out" }] }, true), { text: "Command timed out", tone: "warning" });
  assert.equal(partialProgress({ content: [{ type: "text", text: "first\nlast\x1b]0;bad\x07" }] }), "last");
});

test("built-in renderer matches live and final compact rows while expanded delegates", () => {
  const registered = new Map<string, any>();
  const activity = new ToolActivityController(undefined, () => 1_000);
  const renderers = setupToolRenderers(
    { registerTool(tool: any) { registered.set(tool.name, tool); } } as never,
    activity,
  );
  const read = registered.get("read");
  const state = {};
  const base = {
    args: { path: "src/a.ts" },
    toolCallId: "call-1",
    invalidate() {},
    state,
    cwd: process.cwd(),
    executionStarted: true,
    argsComplete: true,
    isPartial: true,
    expanded: false,
    showImages: true,
    isError: false,
  };
  activity.start("call-1", "read");
  const started = read.renderCall(base.args, theme, { ...base, isPartial: false }).render(80).join("\n");
  assert.match(started, /read src\/a\.ts/u);
  activity.update("call-1", "read", { content: [{ type: "text", text: "loading line 2" }] });
  const live = read.renderCall(base.args, theme, base).render(80).join("\n");
  assert.match(live, /read src\/a\.ts/u);
  assert.match(live, /loading line 2/u);
  assert.deepEqual(read.renderResult({ content: [{ type: "text", text: "loading" }] }, { expanded: false, isPartial: true }, theme, base).render(80), []);
  activity.end("call-1");
  const finalContext = { ...base, isPartial: false };
  assert.deepEqual(read.renderCall(base.args, theme, finalContext).render(80), []);
  const final = read.renderResult({ content: [{ type: "text", text: "one\ntwo\n" }] }, { expanded: false, isPartial: false }, theme, finalContext).render(80).join("\n");
  assert.match(final, /✓.*read.*2 lines/u);
  const expanded = read.renderCall(base.args, theme, { ...finalContext, expanded: true }).render(80);
  assert.ok(expanded.length > 0);
  assert.deepEqual(read.renderCall(base.args, theme, finalContext).render(80), []);
  assert.equal(activity.get("call-1"), undefined);

  activity.start("call-expanded", "read");
  activity.end("call-expanded");
  const expandedState = {};
  read.renderResult(
    { content: [{ type: "text", text: "done" }] },
    { expanded: true, isPartial: false },
    theme,
    { ...finalContext, toolCallId: "call-expanded", state: expandedState, expanded: true },
  );
  assert.equal(activity.get("call-expanded"), undefined);
  assert.deepEqual(read.renderCall(base.args, theme, {
    ...finalContext,
    toolCallId: "call-expanded",
    state: expandedState,
  }).render(80), []);
  activity.clear();
  renderers.clear();
});

test("compact tool components rebuild themed text after invalidation", () => {
  const registered = new Map<string, any>();
  const activity = new ToolActivityController(undefined, () => 1_000);
  const renderers = setupToolRenderers(
    { registerTool(tool: any) { registered.set(tool.name, tool); } } as never,
    activity,
  );
  let marker = "old:";
  const liveTheme = {
    ...theme,
    fg: (_color: string, text: string) => `${marker}${text}`,
  };
  const context = {
    args: { path: "src/a.ts" },
    toolCallId: "theme-call",
    invalidate() {},
    state: {},
    cwd: process.cwd(),
    executionStarted: true,
    argsComplete: true,
    isPartial: false,
    expanded: false,
    showImages: true,
    isError: false,
  };
  activity.start("theme-call", "read");
  const component = registered.get("read").renderCall(context.args, liveTheme, context);
  assert.match(component.render(120).join("\n"), /old:/u);
  marker = "new:";
  component.invalidate();
  assert.match(component.render(120).join("\n"), /new:/u);
  activity.clear();
  renderers.clear();
});

test("coalescing job owns one run and one bounded rerun", async () => {
  const releases: Array<() => void> = [];
  let runs = 0;
  const job = new CoalescingJob(async () => {
    runs += 1;
    await new Promise<void>((resolve) => releases.push(resolve));
  });
  const first = job.request();
  job.request();
  job.request();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runs, 1);
  releases.shift()?.();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runs, 2);
  releases.shift()?.();
  await first;
  job.dispose();
  await job.request();
  assert.equal(runs, 2);
});

test("collector rejects stale work and clears all owned intervals", async () => {
  const callbacks: Array<() => void> = [];
  const cleared: number[] = [];
  const controller = new AbortController();
  let current = true;
  const collector = new TelemetryCollector({
    cwd: "/repo",
    signal: controller.signal,
    isCurrent: () => current,
    onChange() {},
    setInterval(callback) {
      callbacks.push(callback);
      return callbacks.length as unknown as ReturnType<typeof setInterval>;
    },
    clearInterval(timer) { cleared.push(timer as unknown as number); },
    exec: async (command, args) => {
      if (command === "git") return { code: 0, stdout: "# branch.head main\n# branch.ab +0 -0\n", stderr: "" };
      if (args[0] === "pr") return { code: 1, stdout: "", stderr: "no pull requests found" };
      return { code: 0, stdout: "0\n", stderr: "" };
    },
  });
  collector.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(callbacks.length, 3);
  assert.equal(collector.get().git.kind, "ready");
  current = false;
  controller.abort();
  collector.stop();
  assert.deepEqual(cleared, [1, 2, 3]);
  callbacks[0]?.();
  assert.equal(collector.get().health.git.requests, 1);
});

test("animation clock uses one timer and cleans it when inactive", () => {
  let callback: (() => void) | undefined;
  let timers = 0;
  let clears = 0;
  let ticks = 0;
  const clock = new AnimationClock(100, ((next: () => void) => {
    timers += 1;
    callback = next;
    return 1 as unknown as ReturnType<typeof setInterval>;
  }) as typeof setInterval, (() => { clears += 1; }) as typeof clearInterval);
  clock.start("agent", () => { ticks += 1; });
  clock.start("tool", () => { ticks += 1; });
  assert.equal(timers, 1);
  callback?.();
  assert.equal(ticks, 2);
  clock.stop("agent");
  assert.equal(clears, 0);
  clock.stop("tool");
  assert.equal(clears, 1);
});
