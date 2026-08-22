import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import workMode, {
  WORK_MODES,
  WORK_MODE_CONTRACTS,
  guardGitPush,
  isGitPushCommand,
  modeCompletions,
  parseWorkMode,
  readParentMode,
  resolveInitialMode,
  restoreModeFromBranch,
  workModePrompt,
} from "./work-mode.ts";

function custom(mode: string | null, id = "mode", parentId: string | null = null) {
  return { type: "custom", id, parentId, customType: "work-mode", data: { mode } };
}

test("parses direct mode selection, off, and completions", () => {
  assert.equal(parseWorkMode(" guided "), "guided");
  assert.equal(parseWorkMode("vibe-quick"), "vibe-quick");
  assert.equal(parseWorkMode("off"), "off");
  assert.equal(parseWorkMode("fast"), undefined);
  assert.deepEqual(modeCompletions("vibe-s")?.map((item) => item.value), ["vibe-solo"]);
});

test("restores latest mode on active branch and honors off", () => {
  assert.deepEqual(restoreModeFromBranch([custom("guided"), custom("vibe-quick", "next", "mode")]), {
    found: true,
    mode: "vibe-quick",
  });
  assert.deepEqual(restoreModeFromBranch([custom("guided"), custom(null, "off", "mode")]), {
    found: true,
  });
  assert.deepEqual(restoreModeFromBranch([]), { found: false });
});

test("inherits only from explicit linked parent", () => {
  assert.deepEqual(resolveInitialMode([], null, () => "guided"), { inherited: false });
  assert.deepEqual(
    resolveInitialMode([], { parentSession: "/parent.jsonl" }, () => "vibe-collab"),
    { mode: "vibe-collab", inherited: true },
  );
  assert.deepEqual(
    resolveInitialMode([custom(null)], { parentSession: "/parent.jsonl" }, () => "guided"),
    { inherited: false },
  );
});

test("reads mode from linked parent active branch", () => {
  const directory = mkdtempSync(join(tmpdir(), "work-mode-"));
  const session = join(directory, "parent.jsonl");
  try {
    writeFileSync(session, [
      JSON.stringify({ type: "session", version: 3, id: "session", cwd: "/repo" }),
      JSON.stringify(custom("guided", "first")),
      JSON.stringify(custom("vibe-quick", "second", "first")),
      "",
    ].join("\n"));
    assert.equal(readParentMode(session), "vibe-quick");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("every contract preserves stop point and explicit Git authority through Plan and Goal", () => {
  for (const mode of WORK_MODES) {
    assert.ok(WORK_MODE_CONTRACTS[mode].length > 100);
    const prompt = workModePrompt(mode);
    assert.match(prompt, /final Plan must name this mode's stop point and Git authority/);
    assert.match(prompt, /Goal may call completion only after reaching that stop point/);
  }
  assert.match(workModePrompt("guided"), /Do not commit, push, open a PR/);
  assert.match(workModePrompt("vibe-solo"), /signed commit.*push it/);
  assert.match(workModePrompt("vibe-solo"), /standing authority/);
  assert.match(workModePrompt("vibe-collab"), /collaborator conventions/);
  assert.match(workModePrompt("vibe-quick"), /signed commit.*push it/);
  assert.match(workModePrompt("vibe-quick"), /smallest useful smoke check/);
  assert.doesNotMatch(workModePrompt("vibe-solo"), /ask before push|prior explicit user request/);
  assert.doesNotMatch(workModePrompt("vibe-quick"), /ask before push|prior explicit user request/);
});

test("detects git push without matching prose or other git commands", () => {
  for (const command of [
    "git push",
    "git -C repo push origin main",
    "command git --no-pager push",
    "sudo -u deploy git push",
    "env -u GIT_CONFIG git push",
    "if git push; then echo done; fi",
    "git status && git push",
    "bash -c 'git push origin HEAD'",
  ]) assert.equal(isGitPushCommand(command), true, command);
  for (const command of ["git status", "echo git push", "printf 'git push\\n'"]) {
    assert.equal(isGitPushCommand(command), false, command);
  }
});

test("push guard bypasses confirmation for solo modes and guards collaborative modes", async () => {
  const context = (confirmed: boolean) => ({
    hasUI: true,
    mode: "tui" as const,
    ui: { confirm: async () => confirmed },
  });
  assert.deepEqual(await guardGitPush("git push", "guided", context(true) as never), { block: false });
  assert.deepEqual(await guardGitPush("git push", "vibe-solo", context(false) as never), { block: false });
  assert.deepEqual(
    await guardGitPush("git push", "vibe-quick", { hasUI: false, mode: "print", ui: {} } as never),
    { block: false },
  );
  assert.match(
    (await guardGitPush("git push", "guided", context(false) as never)).reason ?? "",
    /denied by user/,
  );
  assert.match(
    (await guardGitPush("git push", "guided", { hasUI: false, mode: "print", ui: {} } as never)).reason ?? "",
    /confirmation UI is unavailable/,
  );
  assert.deepEqual(await guardGitPush("git status", "guided", context(false) as never), { block: false });
});

test("command selection and off update stable status lifecycle", async () => {
  const commands = new Map<string, any>();
  const handlers = new Map<string, any>();
  const entries: unknown[] = [];
  const statuses: Array<[string, string | undefined]> = [];
  const pi = {
    registerCommand(name: string, command: unknown) { commands.set(name, command); },
    on(name: string, handler: unknown) { handlers.set(name, handler); },
    appendEntry(_type: string, data: unknown) { entries.push(data); },
  };
  workMode(pi as never);
  const ctx = {
    hasUI: true,
    mode: "tui",
    ui: {
      setStatus(key: string, value?: string) { statuses.push([key, value]); },
      notify() {},
      select: async () => undefined,
    },
    sessionManager: {
      getBranch: () => [],
      getHeader: () => null,
      getSessionFile: () => "/session.jsonl",
    },
  };
  handlers.get("session_start")({}, ctx);
  await commands.get("mode").handler("guided", ctx);
  handlers.get("session_before_switch")({ reason: "new" }, ctx);
  assert.deepEqual(resolveInitialMode([], { parentSession: "/session.jsonl" }, () => "guided"), {
    mode: "guided",
    inherited: true,
  });
  await commands.get("mode").handler("off", ctx);
  assert.deepEqual(entries, [{ mode: "guided" }, { mode: "guided" }, { mode: null }]);
  assert.deepEqual(statuses.slice(-2), [["work-mode", "mode guided"], ["work-mode", undefined]]);
  handlers.get("session_shutdown")({}, ctx);
  assert.deepEqual(statuses.at(-1), ["work-mode", undefined]);
});
