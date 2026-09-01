import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  WORK_MODES,
  WORK_MODE_CONTRACTS,
  isGitPushCommand,
  modeCompletions,
  parseWorkMode,
  readParentMode,
  registerWorkMode,
  resolveInitialMode,
  restoreModeFromBranch,
  workModePrompt,
} from "./menu.ts";

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

test("restores latest mode on active branch and honors explicit off", () => {
  assert.deepEqual(restoreModeFromBranch([custom("guided"), custom("vibe-quick", "next", "mode")]), { found: true, mode: "vibe-quick" });
  assert.deepEqual(restoreModeFromBranch([custom("guided"), custom(null, "off", "mode")]), { found: true });
  assert.deepEqual(restoreModeFromBranch([]), { found: false });
});

test("inherits only from an explicit linked parent", () => {
  assert.deepEqual(resolveInitialMode([], null, () => "guided"), { inherited: false });
  assert.deepEqual(resolveInitialMode([], { parentSession: "/parent.jsonl" }, () => "vibe-collab"), { mode: "vibe-collab", inherited: true });
  assert.deepEqual(resolveInitialMode([custom(null)], { parentSession: "/parent.jsonl" }, () => "guided"), { inherited: false });
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

test("every prompt contract preserves stop point and explicit Git authority", () => {
  for (const mode of WORK_MODES) {
    assert.ok(WORK_MODE_CONTRACTS[mode].length > 100);
    const prompt = workModePrompt(mode);
    assert.match(prompt, /final Plan must name this mode's stop point and Git authority/u);
    assert.match(prompt, /Goal may call completion only after reaching that stop point/u);
  }
  assert.match(workModePrompt("guided"), /Do not commit, push, open a PR/u);
  assert.match(workModePrompt("vibe-solo"), /signed commit.*push it/u);
  assert.match(workModePrompt("vibe-solo"), /standing authority/u);
  assert.match(workModePrompt("vibe-collab"), /collaborator conventions/u);
  assert.match(workModePrompt("vibe-quick"), /smallest useful smoke check/u);
});

test("direct command selection persists and publishes stable status", async () => {
  const commands = new Map<string, any>();
  const handlers = new Map<string, any>();
  const entries: unknown[] = [];
  const statuses: Array<[string, string | undefined]> = [];
  const pi = {
    registerCommand(name: string, command: unknown) { commands.set(name, command); },
    on(name: string, handler: unknown) { handlers.set(name, handler); },
    appendEntry(_type: string, data: unknown) { entries.push(data); },
  };
  registerWorkMode(pi as never, () => undefined);
  const ctx = {
    mode: "tui",
    hasUI: true,
    ui: {
      setStatus(key: string, value?: string) { statuses.push([key, value]); },
      notify() {},
    },
    sessionManager: { getBranch: () => [], getHeader: () => null },
  };
  handlers.get("session_start")({}, ctx);
  await commands.get("mode").handler("guided", ctx);
  handlers.get("session_before_switch")({ reason: "new" }, ctx);
  await commands.get("mode").handler("off", ctx);
  assert.deepEqual(entries, [{ mode: "guided" }, { mode: "guided" }, { mode: null }]);
  assert.deepEqual(statuses.slice(-2), [["work-mode", "mode guided"], ["work-mode", undefined]]);
  handlers.get("session_shutdown")({}, ctx);
  assert.deepEqual(statuses.at(-1), ["work-mode", undefined]);
});

test("detects wrapped Git push without matching prose or other Git commands", () => {
  for (const command of [
    "git push",
    "git -C repo push origin main",
    "command git --no-pager push",
    "exec git push",
    "{ git push; }",
    "git -c alias.p=push p",
    "git -c 'alias.p=!git push' p",
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
