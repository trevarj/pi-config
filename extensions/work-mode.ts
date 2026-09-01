import { readFileSync } from "node:fs";
import { stripVTControlCharacters } from "node:util";

interface AutocompleteItem {
  value: string;
  label: string;
  description?: string;
}

interface WorkModeUI {
  setStatus(key: string, value?: string): void;
  notify(message: string, level?: "info" | "warning" | "error"): void;
  select(title: string, options: string[]): Promise<string | undefined>;
  confirm(title: string, message: string): Promise<boolean>;
}

interface WorkModeContext {
  hasUI: boolean;
  mode: "tui" | "rpc" | "json" | "print";
  ui: WorkModeUI;
  sessionManager: {
    getBranch(): unknown[];
    getHeader(): { parentSession?: string } | null;
  };
}

interface WorkModeEvent {
  reason?: string;
  systemPrompt?: string;
  toolName?: string;
  input?: { command?: unknown };
  command?: string;
}

interface WorkModeExtensionAPI {
  appendEntry<T>(customType: string, data?: T): void;
  registerCommand(name: string, command: {
    description: string;
    getArgumentCompletions(prefix: string): AutocompleteItem[] | null;
    handler(args: string, ctx: WorkModeContext): Promise<void>;
  }): void;
  on(event: string, handler: (event: WorkModeEvent, ctx: WorkModeContext) => unknown): void;
}

export const WORK_MODE_STATUS_KEY = "work-mode";
export const WORK_MODE_ENTRY_TYPE = "work-mode";
export const WORK_MODES = ["guided", "vibe-solo", "vibe-collab", "vibe-quick"] as const;

export type WorkMode = (typeof WORK_MODES)[number];

type StoredMode = { mode: WorkMode | null };
type ModeState = { found: boolean; mode?: WorkMode };

const MODE_LABELS: Record<WorkMode, string> = {
  guided: "guided — high-assurance collaboration",
  "vibe-solo": "vibe-solo — own implementation through signed commit and push",
  "vibe-collab": "vibe-collab — conform to collaborator conventions",
  "vibe-quick": "vibe-quick — minimum low-risk change through signed commit and push",
};

export const WORK_MODE_CONTRACTS: Record<WorkMode, string> = {
  guided: `High-assurance collaborative work. Resolve repository facts first. Ask only material product or architecture questions. Implement and fully verify, then self-review and stop ready for user code review. Do not commit, push, open a PR, post remote comments, or resolve threads unless the user explicitly requests that action.`,
  "vibe-solo": `Own implementation end to end with strong automated verification and self-review. After verification, create a signed commit containing only intended task changes and push it. Do not stop or ask for commit or push confirmation; selecting this mode grants standing authority for both. Do not open a PR.`,
  "vibe-collab": `First inspect repository instructions, nearby code, history, and collaborator conventions. Conform instead of introducing new patterns. Implement, verify, self-review, and stop ready for user review. Do not commit or perform remote actions unless the user explicitly requests them.`,
  "vibe-quick": `Make low-risk assumptions, use the minimum working solution, avoid speculative scaffolding, and run the smallest useful smoke check. In an existing Git repository, create a signed commit containing only intended task changes and push it. Do not stop or ask for commit or push confirmation; selecting this mode grants standing authority for both. Never initialize Git only to commit.`,
};

export function parseWorkMode(value: string): WorkMode | "off" | undefined {
  const normalized = value.trim().toLowerCase();
  if (normalized === "off") return "off";
  return WORK_MODES.find((mode) => mode === normalized);
}

export function modeCompletions(prefix: string): AutocompleteItem[] | null {
  const normalized = prefix.trim().toLowerCase();
  const items: AutocompleteItem[] = [];
  for (const value of [...WORK_MODES, "off"] as const) {
    if (!value.startsWith(normalized)) continue;
    items.push({
      value,
      label: value,
      description: value === "off" ? "Clear session work mode" : MODE_LABELS[value],
    });
  }
  return items.length ? items : null;
}

export function restoreModeFromBranch(entries: readonly unknown[]): ModeState {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index] as {
      type?: unknown;
      customType?: unknown;
      data?: unknown;
    };
    if (entry.type !== "custom" || entry.customType !== WORK_MODE_ENTRY_TYPE) continue;
    const data = entry.data as Partial<StoredMode> | undefined;
    if (data?.mode === null) return { found: true };
    if (typeof data?.mode === "string" && WORK_MODES.includes(data.mode as WorkMode)) {
      return { found: true, mode: data.mode as WorkMode };
    }
  }
  return { found: false };
}

export function readParentMode(sessionFile: string): WorkMode | undefined {
  try {
    const lines = readFileSync(sessionFile, "utf8").split("\n").filter(Boolean);
    const entries = lines.slice(1).map((line) => JSON.parse(line) as {
      id: string;
      parentId: string | null;
      type?: unknown;
      customType?: unknown;
      data?: unknown;
    });
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    const branch: typeof entries = [];
    let entry = entries.at(-1);
    while (entry) {
      branch.push(entry);
      entry = entry.parentId ? byId.get(entry.parentId) : undefined;
    }
    return restoreModeFromBranch(branch.toReversed()).mode;
  } catch {
    return undefined;
  }
}

export function resolveInitialMode(
  branch: readonly unknown[],
  header: { parentSession?: string } | null,
  parentReader: (path: string) => WorkMode | undefined = readParentMode,
): { mode?: WorkMode; inherited: boolean } {
  const restored = restoreModeFromBranch(branch);
  if (restored.found) {
    return restored.mode ? { mode: restored.mode, inherited: false } : { inherited: false };
  }
  if (!header?.parentSession) return { inherited: false };
  try {
    const mode = parentReader(header.parentSession);
    return mode ? { mode, inherited: true } : { inherited: false };
  } catch {
    return { inherited: false };
  }
}

export function workModePrompt(mode: WorkMode): string {
  return `# Session work mode: ${mode}\n\n${WORK_MODE_CONTRACTS[mode]}\n\nIf Plan mode is used, its final Plan must name this mode's stop point and Git authority so a same-session or fresh Goal handoff preserves the contract. Goal may call completion only after reaching that stop point. Follow the mode's Git authority without asking for redundant confirmation.`;
}

function shellTokens(command: string): string[] {
  const tokens: string[] = [];
  let token = "";
  let quote: "'" | '"' | undefined;
  const flush = () => {
    if (token) tokens.push(token);
    token = "";
  };

  for (let index = 0; index < command.length; index++) {
    const character = command[index] ?? "";
    if (quote) {
      if (character === quote) quote = undefined;
      else if (character === "\\" && quote === '"' && index + 1 < command.length) token += command[++index];
      else token += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === "\\" && index + 1 < command.length) {
      token += command[++index];
      continue;
    }
    if (character === "#" && !token) {
      while (index + 1 < command.length && command[index + 1] !== "\n") index++;
      continue;
    }
    if (/\s/.test(character)) {
      flush();
      if (character === "\n") tokens.push(";");
      continue;
    }
    if (";&|(){}".includes(character)) {
      flush();
      const next = command[index + 1];
      if ((character === "&" || character === "|") && next === character) index++;
      tokens.push(";");
      continue;
    }
    token += character;
  }
  flush();
  return tokens;
}

function skipOptions(tokens: string[], index: number, optionsWithValues: ReadonlySet<string>): number {
  while ((tokens[index] ?? "").startsWith("-")) {
    const option = tokens[index] ?? "";
    index++;
    if (!option.includes("=") && optionsWithValues.has(option)) index++;
  }
  return index;
}

function gitSubcommand(tokens: string[]): string | undefined {
  let index = 0;
  const shellKeywords = new Set(["!", "if", "then", "while", "until", "do", "{"]);
  while (shellKeywords.has(tokens[index] ?? "")) index++;
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index] ?? "")) index++;
  for (;;) {
    const wrapper = pathBasename(tokens[index] ?? "");
    if (wrapper === "command" || wrapper === "exec" || wrapper === "time") {
      index = skipOptions(tokens, index + 1, new Set());
      continue;
    }
    if (wrapper === "env") {
      index = skipOptions(tokens, index + 1, new Set(["-u", "--unset", "-C", "--chdir", "-S", "--split-string"]));
      while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index] ?? "")) index++;
      continue;
    }
    if (wrapper === "sudo") {
      index = skipOptions(tokens, index + 1, new Set(["-u", "--user", "-g", "--group", "-h", "--host", "-p", "--prompt", "-C", "--close-from", "-T", "--command-timeout"]));
      continue;
    }
    break;
  }

  const executable = pathBasename(tokens[index] ?? "");
  if (["sh", "bash", "zsh"].includes(executable)) {
    const commandIndex = tokens.indexOf("-c", index + 1);
    return commandIndex >= 0 && isGitPushCommand(tokens[commandIndex + 1] ?? "") ? "push" : undefined;
  }
  if (executable === "eval") return isGitPushCommand(tokens.slice(index + 1).join(" ")) ? "push" : undefined;
  if (executable !== "git") return undefined;

  const pushAliases = new Set<string>();
  for (index++; index < tokens.length; index++) {
    const value = tokens[index] ?? "";
    if (value === "-c") {
      const setting = tokens[++index] ?? "";
      const alias = setting.match(/^alias\.([^=]+)=(.*)$/);
      if (alias?.[1] && /(?:^|\s|!)push(?:\s|$)/.test(alias[2] ?? "")) {
        pushAliases.add(alias[1]);
      }
      continue;
    }
    if (["-C", "--git-dir", "--work-tree", "--namespace", "--exec-path"].includes(value)) {
      index++;
      continue;
    }
    if (!value.startsWith("-")) return pushAliases.has(value) ? "push" : value;
  }
  return undefined;
}

function isGitCommand(command: string, subcommand: "commit" | "push"): boolean {
  const segments: string[][] = [[]];
  for (const token of shellTokens(command)) {
    if (token === ";") segments.push([]);
    else segments.at(-1)?.push(token);
  }
  return segments.some((segment) => gitSubcommand(segment) === subcommand);
}

export function isGitPushCommand(command: string): boolean {
  return isGitCommand(command, "push");
}

function pathBasename(value: string): string {
  return value.split(/[\\/]/).at(-1) ?? "";
}

export async function guardGitPush(
  command: string,
  mode: WorkMode | undefined,
  ctx: Pick<WorkModeContext, "hasUI" | "mode" | "ui">,
): Promise<{ block: boolean; reason?: string }> {
  const isPush = isGitPushCommand(command);
  if (!mode || !isPush) return { block: false };
  if (mode === "vibe-solo" || mode === "vibe-quick") return { block: false };
  if (!ctx.hasUI || (ctx.mode !== "tui" && ctx.mode !== "rpc")) {
    return { block: true, reason: `git push blocked in ${mode} mode because confirmation UI is unavailable` };
  }
  try {
    const allowed = await ctx.ui.confirm(
      `Confirm git push (${mode})`,
      `Allow this exact command?\n\n${JSON.stringify(stripVTControlCharacters(command))}`,
    );
    return allowed
      ? { block: false }
      : { block: true, reason: `git push denied by user in ${mode} mode` };
  } catch {
    return { block: true, reason: `git push blocked in ${mode} mode because confirmation failed` };
  }
}

export default function workMode(pi: WorkModeExtensionAPI) {
  let selected: WorkMode | undefined;
  let lastContext: WorkModeContext | undefined;

  const publishStatus = (ctx: WorkModeContext) => {
    ctx.ui.setStatus(WORK_MODE_STATUS_KEY, selected ? `mode ${selected}` : undefined);
  };
  const selectMode = (mode: WorkMode | undefined, ctx: WorkModeContext) => {
    selected = mode;
    pi.appendEntry<StoredMode>(WORK_MODE_ENTRY_TYPE, { mode: mode ?? null });
    publishStatus(ctx);
  };
  const snapshotLinkedParent = () => {
    if (selected) pi.appendEntry<StoredMode>(WORK_MODE_ENTRY_TYPE, { mode: selected });
  };

  pi.registerCommand("mode", {
    description: "Select session work mode",
    getArgumentCompletions: modeCompletions,
    handler: async (args, ctx) => {
      const argument = args.trim();
      if (argument) {
        const mode = parseWorkMode(argument);
        if (!mode) {
          ctx.ui.notify(`Unknown mode: ${argument}`, "error");
          return;
        }
        selectMode(mode === "off" ? undefined : mode, ctx);
        return;
      }
      if (!ctx.hasUI) {
        ctx.ui.notify("/mode requires TUI or RPC UI, or use /mode <name>", "error");
        return;
      }
      const choice = await ctx.ui.select("Session work mode", [
        ...WORK_MODES.map((mode) => MODE_LABELS[mode]),
        "off — clear session work mode",
      ]);
      if (!choice) return;
      const mode = choice.startsWith("off")
        ? undefined
        : WORK_MODES.find((candidate) => choice.startsWith(candidate));
      selectMode(mode, ctx);
    },
  });

  pi.on("session_start", (_event, ctx) => {
    lastContext = ctx;
    const resolved = resolveInitialMode(ctx.sessionManager.getBranch(), ctx.sessionManager.getHeader());
    selected = resolved.mode;
    if (resolved.inherited && selected) pi.appendEntry<StoredMode>(WORK_MODE_ENTRY_TYPE, { mode: selected });
    publishStatus(ctx);
  });
  pi.on("session_tree", (_event, ctx) => {
    selected = restoreModeFromBranch(ctx.sessionManager.getBranch()).mode;
    publishStatus(ctx);
  });
  // Make active parent branch the file's latest branch before Pi creates a linked session.
  pi.on("session_before_switch", (event) => {
    if (event.reason === "new") snapshotLinkedParent();
  });
  pi.on("session_before_fork", snapshotLinkedParent);
  pi.on("before_agent_start", (event) => {
    if (!selected) return;
    return { systemPrompt: `${event.systemPrompt ?? ""}\n\n${workModePrompt(selected)}` };
  });
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return;
    const result = await guardGitPush(String(event.input?.command ?? ""), selected, ctx);
    return result.block ? { block: true, reason: result.reason } : undefined;
  });
  pi.on("user_bash", async (event, ctx) => {
    const result = await guardGitPush(event.command ?? "", selected, ctx);
    if (!result.block) return;
    return {
      result: {
        output: result.reason ?? "git push blocked",
        exitCode: 1,
        cancelled: false,
        truncated: false,
      },
    };
  });
  pi.on("session_shutdown", () => {
    lastContext?.ui.setStatus(WORK_MODE_STATUS_KEY, undefined);
    lastContext = undefined;
    selected = undefined;
  });
}
