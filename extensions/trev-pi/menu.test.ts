import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { runMenu } from "@narumitw/pi-tui-kit";
import { createRpcHarness, createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import {
  buildDashboardState,
  createDashboardMenu,
  createModeMenu,
  guardGitPush,
  type DashboardData,
} from "./menu.ts";
import type { TelemetrySnapshot } from "./state.ts";

function telemetry(): TelemetrySnapshot {
  return {
    git: { kind: "empty", reason: "Not a Git repository", updatedAt: 1 },
    pullRequest: { kind: "empty", reason: "No pull request for current branch", updatedAt: 1 },
    notifications: { kind: "ready", value: 0, updatedAt: 1 },
    health: {
      git: { id: "git", command: "git status --porcelain=v2 --branch", refresh: "startup + 30s", requests: 1, runs: 1, coalesced: 0, inFlight: false, queued: false, lastSuccessAt: 1 },
      "pull-request": { id: "pull-request", command: "gh pr view --json fields", refresh: "startup + 60s", requests: 1, runs: 1, coalesced: 0, inFlight: false, queued: false, lastSuccessAt: 1 },
      notifications: { id: "notifications", command: "gh api notifications --paginate", refresh: "startup + 5m", requests: 1, runs: 1, coalesced: 0, inFlight: false, queued: false, lastSuccessAt: 1 },
    },
  };
}

function dashboardData(): DashboardData {
  return {
    runtime: { mode: "tui", activity: "active", provider: "openai-codex", model: "gpt-test", thinking: "high", projectTrusted: true },
    session: { id: "session-id", name: "test", file: "/tmp/session.jsonl", cwd: "/repo", entries: 2, branchEntries: 2, pending: false },
    telemetry: telemetry(),
    context: "10/100",
    cache: "5r",
    providerUsage: "80%",
    statuses: [["work-mode", "mode guided"]],
    tools: [{ name: "read", active: true, description: "Read", source: "builtin", path: "<builtin:read>" }],
    commands: [{ name: "dashboard", description: "Dashboard", source: "extension", scope: "user", origin: "package", path: "/pkg/index.ts" }],
  };
}

function context(mode: "tui" | "rpc" | "print", ui: object) {
  return { mode, hasUI: mode !== "print", ui } as any;
}

test("dashboard TUI searches, opens details, survives resize, backs out, and closes", async () => {
  const tui = createTuiHarness({ width: 80, rows: 24 });
  const controller = new AbortController();
  const running = runMenu(context("tui", { custom: tui.custom }), createDashboardMenu(), {
    getState: () => buildDashboardState(dashboardData()),
    signal: controller.signal,
    isCurrent: () => !controller.signal.aborted,
  });
  await tui.waitForOpen();
  tui.setFocused(true);
  tui.type("GitHub");
  assert.match(tui.render().join("\n"), /GitHub/u);
  tui.press("tui.select.confirm");
  assert.match(tui.render().join("\n"), /notifications/u);
  tui.resize({ width: 40, rows: 10 });
  for (const line of tui.render()) assert.ok(visibleWidth(line) <= 40, line);
  tui.press("tui.select.cancel");
  assert.match(tui.render().join("\n"), /GitHub/u);
  tui.press("ctrl+c");
  assert.deepEqual(await running, { kind: "closed", reason: "close" });
});

test("dashboard external disposal and owner abort are stale", async () => {
  const tui = createTuiHarness();
  const controller = new AbortController();
  const running = runMenu(context("tui", { custom: tui.custom }), createDashboardMenu(), {
    getState: () => buildDashboardState(dashboardData()),
    signal: controller.signal,
    isCurrent: () => !controller.signal.aborted,
  });
  await tui.waitForOpen();
  controller.abort();
  tui.dispose();
  assert.deepEqual(await running, { kind: "stale" });
});

test("dashboard RPC uses deterministic detail pagination", async () => {
  const rpc = createRpcHarness([
    { kind: "select", response: "Collector Health [healthy]" },
    { kind: "select", response: "Next" },
    { kind: "select", response: "Back" },
    { kind: "select", response: "Done" },
  ]);
  const result = await runMenu(context("rpc", rpc.ui), createDashboardMenu(), {
    getState: () => buildDashboardState(dashboardData()),
  });
  assert.deepEqual(result, { kind: "closed", reason: "close" });
  rpc.assertConsumed();
});

test("dashboard reports print mode as unsupported", async () => {
  const result = await runMenu(context("print", {}), createDashboardMenu(), {
    getState: () => buildDashboardState(dashboardData()),
  });
  assert.deepEqual(result, { kind: "unsupported", mode: "print" });
});

test("mode choice adapts in TUI and RPC without changing direct identities", async () => {
  let selected: string | undefined;
  const tui = createTuiHarness();
  const tuiRun = runMenu(context("tui", { custom: tui.custom }), createModeMenu(), {
    getState: () => ({ mode: undefined, apply: (mode: string | undefined) => { selected = mode; } }),
  });
  await tui.waitForOpen();
  tui.setFocused(true);
  tui.type("quick");
  tui.press("tui.select.confirm");
  assert.deepEqual(await tuiRun, { kind: "closed", reason: "close" });
  assert.equal(selected, "vibe-quick");

  const rpc = createRpcHarness([{ kind: "select", response: "guided" }]);
  const rpcResult = await runMenu(context("rpc", rpc.ui), createModeMenu(), {
    getState: () => ({ mode: undefined, apply: (mode: string | undefined) => { selected = mode; } }),
  });
  assert.deepEqual(rpcResult, { kind: "closed", reason: "close" });
  assert.equal(selected, "guided");
  rpc.assertConsumed();
});

test("push guard permits only explicit Kit confirmation and fails closed otherwise", async () => {
  const controller = new AbortController();
  const owner = { generation: 1, signal: controller.signal, isCurrent: () => !controller.signal.aborted };
  const ctx = context("tui", {});
  const confirmed = async () => ({ kind: "confirmed" as const });
  assert.deepEqual(await guardGitPush("git push", "guided", ctx, owner, confirmed), { block: false });
  let confirmationMessage = "";
  await guardGitPush("git push\nprintf '\\e]0;spoof\\a'", "guided", ctx, owner, async (_context, options) => {
    confirmationMessage = options.message;
    return { kind: "confirmed" as const };
  });
  assert.match(confirmationMessage, /git push\\nprintf/u);
  assert.doesNotMatch(confirmationMessage, /\x1b\]0;/u);
  for (const result of [
    { kind: "closed", reason: "back" as const },
    { kind: "closed", reason: "close" as const },
    { kind: "stale" as const },
    { kind: "unsupported", mode: "print" as const },
    { kind: "error", error: new Error("boom") },
  ]) {
    const denied = await guardGitPush("git push", "guided", ctx, owner, async () => result as any);
    assert.equal(denied.block, true);
  }
  assert.equal((await guardGitPush("git push", "guided", context("print", {}), owner, confirmed)).block, true);
  assert.equal((await guardGitPush("git push", "vibe-solo", context("print", {}), owner, confirmed)).block, false);
});
