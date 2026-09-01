import { readFileSync } from "node:fs";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { VERSION } from "@earendil-works/pi-coding-agent";
import {
  defineMenu,
  runConfirmation,
  runMenu,
  sanitizeTerminalText,
  type MenuDefinition,
  type RunConfirmationResult,
} from "@narumitw/pi-tui-kit";
import { oneLine, promptCacheTelemetry } from "./presentation.ts";
import type { TelemetrySnapshot } from "./state.ts";

export interface SessionOwner {
  generation: number;
  signal: AbortSignal;
  isCurrent: () => boolean;
}

export interface DashboardState {
  items: Array<{
    id: string;
    label: string;
    statusText: string;
    description: string;
    searchText: string;
    detailDocument: { content: string; format: { kind: "text" } };
  }>;
}

export interface DashboardData {
  runtime: {
    mode: string;
    activity: string;
    provider: string;
    model: string;
    thinking: string;
    projectTrusted: boolean;
  };
  session: {
    id: string;
    name: string;
    file: string;
    cwd: string;
    entries: number;
    branchEntries: number;
    pending: boolean;
  };
  telemetry: Readonly<TelemetrySnapshot>;
  context: string;
  cache: string;
  providerUsage: string;
  statuses: ReadonlyArray<[string, string]>;
  tools: Array<{ name: string; active: boolean; description: string; source: string; path: string }>;
  commands: Array<{ name: string; description: string; source: string; scope: string; origin: string; path: string }>;
}

function detail(lines: readonly string[]): { content: string; format: { kind: "text" } } {
  return { content: `${lines.join("\n")}\n`, format: { kind: "text" } };
}

function timestamp(value: number | undefined): string {
  return value === undefined ? "never" : new Date(value).toISOString();
}

function loadStateLabel(state: { kind: string }): string {
  return state.kind === "ready" ? "ready" : state.kind === "empty" ? "none" : state.kind;
}

export function buildDashboardState(data: DashboardData): DashboardState {
  const git = data.telemetry.git;
  const pr = data.telemetry.pullRequest;
  const notifications = data.telemetry.notifications;
  const gitLines = git.kind === "ready"
    ? [
        `branch.head: ${git.value.branch}`,
        `branch.oid: ${git.value.oid ?? "unknown"}`,
        `branch.upstream: ${git.value.upstream ?? "none"}`,
        `branch.ahead: ${git.value.ahead}`,
        `branch.behind: ${git.value.behind}`,
        `status.staged: ${git.value.staged}`,
        `status.unstaged: ${git.value.unstaged}`,
        `status.untracked: ${git.value.untracked}`,
        `status.conflicted: ${git.value.conflicted}`,
        `status.changed: ${git.value.changed}`,
      ]
    : [
        `state: ${git.kind}`,
        git.kind === "empty" ? `reason: ${oneLine(git.reason)}` : git.kind === "error" ? `failure: ${oneLine(git.message)}` : "reason: initial refresh pending",
      ];
  const prLines = pr.kind === "ready"
    ? [
        `pullRequest.number: ${pr.value.number}`,
        `pullRequest.url: ${pr.value.url}`,
        `pullRequest.state: ${pr.value.state}`,
        `pullRequest.isDraft: ${pr.value.isDraft}`,
        `pullRequest.closedAt: ${pr.value.closedAt ?? "none"}`,
        `pullRequest.mergedAt: ${pr.value.mergedAt ?? "none"}`,
        `pullRequest.reviewDecision: ${pr.value.reviewDecision}`,
        `checks.total: ${pr.value.checks.total}`,
        `checks.success: ${pr.value.checks.success}`,
        `checks.pending: ${pr.value.checks.pending}`,
        `checks.failure: ${pr.value.checks.failure}`,
        `checks.neutral: ${pr.value.checks.neutral}`,
      ]
    : [
        `state: ${pr.kind}`,
        pr.kind === "empty" ? `reason: ${oneLine(pr.reason)}` : pr.kind === "error" ? `failure: ${oneLine(pr.message)}` : "reason: initial refresh pending",
      ];
  const notificationLines = notifications.kind === "ready"
    ? [`notifications.unread: ${notifications.value}`]
    : [
        `notifications.state: ${notifications.kind}`,
        notifications.kind === "error" ? `notifications.failure: ${oneLine(notifications.message)}` : "notifications.value: unavailable",
      ];
  const collectorLines = Object.values(data.telemetry.health).flatMap((health) => [
    `[${health.id}]`,
    `command: ${health.command}`,
    `refresh: ${health.refresh}`,
    `requests: ${health.requests}`,
    `runs: ${health.runs}`,
    `coalesced: ${health.coalesced}`,
    `inFlight: ${health.inFlight}`,
    `queued: ${health.queued}`,
    `lastAttemptAt: ${timestamp(health.lastAttemptAt)}`,
    `lastSuccessAt: ${timestamp(health.lastSuccessAt)}`,
    `failure: ${health.failure ?? "none"}`,
    "",
  ]);
  const activeTools = data.tools.filter((tool) => tool.active).length;
  const collectorFailures = Object.values(data.telemetry.health).filter((health) => health.failure).length;
  const items: DashboardState["items"] = [
    {
      id: "runtime",
      label: "Runtime",
      statusText: data.runtime.activity,
      description: "Pi process, model, activity, trust, and presentation mode.",
      searchText: `${data.runtime.provider} ${data.runtime.model} ${data.runtime.thinking}`,
      detailDocument: detail([
        `Pi version: ${VERSION}`,
        `Runtime mode: ${oneLine(data.runtime.mode)}`,
        `TUI mode: regular`,
        `Activity: ${oneLine(data.runtime.activity)}`,
        `Provider: ${oneLine(data.runtime.provider)}`,
        `Model ID: ${oneLine(data.runtime.model)}`,
        `Thinking: ${oneLine(data.runtime.thinking)}`,
        `Project trusted: ${data.runtime.projectTrusted}`,
        `Theme: trev-pi`,
      ]),
    },
    {
      id: "session",
      label: "Session",
      statusText: data.session.pending ? "queued" : "current",
      description: "Current session identity, exact file, project, and resource counts.",
      searchText: `${data.session.id} ${data.session.name} ${data.session.file}`,
      detailDocument: detail([
        `Session ID: ${oneLine(data.session.id)}`,
        `Session name: ${oneLine(data.session.name)}`,
        `Session file: ${data.session.file}`,
        `Working directory: ${data.session.cwd}`,
        `Entries: ${data.session.entries}`,
        `Active branch entries: ${data.session.branchEntries}`,
        `Pending messages: ${data.session.pending}`,
      ]),
    },
    {
      id: "workspace-git",
      label: "Workspace / Git",
      statusText: loadStateLabel(git),
      description: "Cached porcelain-v2 repository and worktree counters.",
      searchText: `${data.session.cwd} ${git.kind === "ready" ? git.value.branch : git.kind}`,
      detailDocument: detail([`Workspace path: ${data.session.cwd}`, "Collector: git", ...gitLines]),
    },
    {
      id: "github",
      label: "GitHub",
      statusText: pr.kind === "ready" ? `PR #${pr.value.number}` : loadStateLabel(pr),
      description: "Current branch pull request, checks, review, and unread notifications.",
      searchText: `pull request checks review notifications ${pr.kind === "ready" ? pr.value.url : ""}`,
      detailDocument: detail([...prLines, ...notificationLines]),
    },
    {
      id: "usage-cache",
      label: "Usage / Cache",
      statusText: oneLine(data.context),
      description: "Current context, latest prompt-cache telemetry, and provider usage status.",
      searchText: `${data.cache} ${data.providerUsage}`,
      detailDocument: detail([
        `Context: ${oneLine(data.context)}`,
        `Prompt cache: ${oneLine(data.cache) || "not reported"}`,
        `Provider usage: ${oneLine(data.providerUsage) || "not reported"}`,
        `Usage status raw key: usage`,
      ]),
    },
    {
      id: "workflows-extensions",
      label: "Workflows / Extensions",
      statusText: `${data.statuses.length} statuses`,
      description: "Compact workflow indicators with exact extension status keys and values.",
      searchText: data.statuses.flat().join(" "),
      detailDocument: detail(data.statuses.length
        ? data.statuses.flatMap(([key, value]) => [`Status key: ${key}`, `Value: ${oneLine(value)}`, ""])
        : ["No extension statuses are currently published."]),
    },
    {
      id: "tools",
      label: "Tools",
      statusText: `${activeTools}/${data.tools.length} active`,
      description: "Active and available tools with exact names, sources, and package paths.",
      searchText: data.tools.map((tool) => `${tool.name} ${tool.source}`).join(" "),
      detailDocument: detail(data.tools.length
        ? data.tools.flatMap((tool) => [
            `${tool.active ? "[active]" : "[inactive]"} ${tool.name}`,
            `source: ${tool.source}`,
            `path: ${tool.path}`,
            `description: ${oneLine(tool.description)}`,
            "",
          ])
        : ["No tools are registered."]),
    },
    {
      id: "resources",
      label: "Resources",
      statusText: `${data.commands.length} commands`,
      description: "Extension commands, prompt templates, and skills with canonical provenance.",
      searchText: data.commands.map((command) => `${command.name} ${command.source} ${command.scope}`).join(" "),
      detailDocument: detail(data.commands.length
        ? data.commands.flatMap((command) => [
            `/${command.name}`,
            `source: ${command.source}`,
            `scope: ${command.scope}`,
            `origin: ${command.origin}`,
            `path: ${command.path}`,
            `description: ${oneLine(command.description) || "none"}`,
            "",
          ])
        : ["No extension, prompt, or skill commands are discoverable."]),
    },
    {
      id: "collector-health",
      label: "Collector Health",
      statusText: collectorFailures ? `${collectorFailures} failed` : "healthy",
      description: "Refresh ownership, exact read-only commands, schedules, coalescing, and failures.",
      searchText: collectorLines.join(" "),
      detailDocument: detail(collectorLines),
    },
  ];
  return { items };
}

export function createDashboardMenu(): MenuDefinition<DashboardState, "catalog", "unused"> {
  return defineMenu<DashboardState, "catalog", "unused">({
    start: "catalog",
    screens: {
      catalog: ({ state }) => ({
        kind: "browse",
        title: "Pi Dashboard",
        lines: ["Search sections, then open exact read-only details."],
        items: state.items,
        viewportSize: "adaptive",
        enableDetailSearch: true,
        hint: "close",
      }),
    },
    actions: { unused: async () => ({ kind: "stay" }) },
  });
}

export async function showDashboard(
  ctx: ExtensionCommandContext,
  owner: SessionOwner,
  getData: () => DashboardData,
): Promise<void> {
  if (ctx.mode === "print" || ctx.mode === "json") {
    throw new Error(`/dashboard is unsupported in ${ctx.mode} mode; use TUI or RPC mode.`);
  }
  await runMenu(ctx, createDashboardMenu(), {
    getState: () => buildDashboardState(getData()),
    signal: owner.signal,
    isCurrent: owner.isCurrent,
    onError: (_context, error) => ctx.ui.notify(`Dashboard failed: ${oneLine(error instanceof Error ? error.message : error)}`, "error"),
    onUnsupportedMode: (_context, mode) => ctx.ui.notify(`/dashboard is unsupported in ${mode} mode.`, "error"),
  });
}

export const WORK_MODE_STATUS_KEY = "work-mode";
export const WORK_MODE_ENTRY_TYPE = "work-mode";
export const WORK_MODES = ["guided", "vibe-solo", "vibe-collab", "vibe-quick"] as const;
export type WorkMode = (typeof WORK_MODES)[number];
type StoredMode = { mode: WorkMode | null };
type ModeState = { found: boolean; mode?: WorkMode };

export const MODE_DESCRIPTIONS: Record<WorkMode, string> = {
  guided: "High-assurance collaboration; stop ready for user review.",
  "vibe-solo": "Own implementation through signed commit and push.",
  "vibe-collab": "Conform to collaborator conventions; stop for review.",
  "vibe-quick": "Minimum low-risk change through signed commit and push.",
};

export const WORK_MODE_CONTRACTS: Record<WorkMode, string> = {
  guided: "High-assurance collaborative work. Resolve repository facts first. Ask only material product or architecture questions. Implement and fully verify, then self-review and stop ready for user code review. Do not commit, push, open a PR, post remote comments, or resolve threads unless the user explicitly requests that action.",
  "vibe-solo": "Own implementation end to end with strong automated verification and self-review. After verification, create a signed commit containing only intended task changes and push it. Do not stop or ask for commit or push confirmation; selecting this mode grants standing authority for both. Do not open a PR.",
  "vibe-collab": "First inspect repository instructions, nearby code, history, and collaborator conventions. Conform instead of introducing new patterns. Implement, verify, self-review, and stop ready for user review. Do not commit or perform remote actions unless the user explicitly requests them.",
  "vibe-quick": "Make low-risk assumptions, use the minimum working solution, avoid speculative scaffolding, and run the smallest useful smoke check. In an existing Git repository, create a signed commit containing only intended task changes and push it. Do not stop or ask for commit or push confirmation; selecting this mode grants standing authority for both. Never initialize Git only to commit.",
};

export function parseWorkMode(value: string): WorkMode | "off" | undefined {
  const normalized = value.trim().toLowerCase();
  if (normalized === "off") return "off";
  return WORK_MODES.find((mode) => mode === normalized);
}

export function modeCompletions(prefix: string) {
  const normalized = prefix.trim().toLowerCase();
  const items = ([...WORK_MODES, "off"] as const)
    .filter((value) => value.startsWith(normalized))
    .map((value) => ({
      value,
      label: value,
      description: value === "off" ? "Clear session work mode" : MODE_DESCRIPTIONS[value],
    }));
  return items.length ? items : null;
}

export function restoreModeFromBranch(entries: readonly unknown[]): ModeState {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index] as { type?: unknown; customType?: unknown; data?: unknown };
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
  if (restored.found) return restored.mode ? { mode: restored.mode, inherited: false } : { inherited: false };
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
  for (let index = 0; index < command.length; index += 1) {
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
      while (index + 1 < command.length && command[index + 1] !== "\n") index += 1;
      continue;
    }
    if (/\s/u.test(character)) {
      flush();
      if (character === "\n") tokens.push(";");
      continue;
    }
    if (";&|(){}".includes(character)) {
      flush();
      const next = command[index + 1];
      if ((character === "&" || character === "|") && next === character) index += 1;
      tokens.push(";");
      continue;
    }
    token += character;
  }
  flush();
  return tokens;
}

function pathBasename(value: string): string {
  return value.split(/[\\/]/u).at(-1) ?? "";
}

function skipOptions(tokens: string[], index: number, optionsWithValues: ReadonlySet<string>): number {
  while ((tokens[index] ?? "").startsWith("-")) {
    const option = tokens[index] ?? "";
    index += 1;
    if (!option.includes("=") && optionsWithValues.has(option)) index += 1;
  }
  return index;
}

function gitSubcommand(tokens: string[]): string | undefined {
  let index = 0;
  const shellKeywords = new Set(["!", "if", "then", "while", "until", "do", "{"]);
  while (shellKeywords.has(tokens[index] ?? "")) index += 1;
  while (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(tokens[index] ?? "")) index += 1;
  for (;;) {
    const wrapper = pathBasename(tokens[index] ?? "");
    if (wrapper === "command" || wrapper === "exec" || wrapper === "time") {
      index = skipOptions(tokens, index + 1, new Set());
      continue;
    }
    if (wrapper === "env") {
      index = skipOptions(tokens, index + 1, new Set(["-u", "--unset", "-C", "--chdir", "-S", "--split-string"]));
      while (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(tokens[index] ?? "")) index += 1;
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
  for (index += 1; index < tokens.length; index += 1) {
    const value = tokens[index] ?? "";
    if (value === "-c") {
      const setting = tokens[++index] ?? "";
      const alias = setting.match(/^alias\.([^=]+)=(.*)$/u);
      if (alias?.[1] && /(?:^|\s|!)push(?:\s|$)/u.test(alias[2] ?? "")) {
        pushAliases.add(alias[1]);
      }
      continue;
    }
    if (["-C", "--git-dir", "--work-tree", "--namespace", "--exec-path"].includes(value)) {
      index += 1;
      continue;
    }
    if (!value.startsWith("-")) return pushAliases.has(value) ? "push" : value;
  }
  return undefined;
}

export function isGitPushCommand(command: string): boolean {
  const segments: string[][] = [[]];
  for (const token of shellTokens(command)) {
    if (token === ";") segments.push([]);
    else segments.at(-1)?.push(token);
  }
  return segments.some((segment) => gitSubcommand(segment) === "push");
}

type ConfirmationRunner = (
  ctx: ExtensionContext,
  options: {
    title: string;
    message: string;
    confirmLabel: string;
    cancelLabel: string;
    signal?: AbortSignal;
    isCurrent(): boolean;
  },
) => Promise<RunConfirmationResult>;

export async function guardGitPush(
  command: string,
  mode: WorkMode | undefined,
  ctx: ExtensionContext,
  owner: SessionOwner,
  confirm: ConfirmationRunner = (context, options) => runConfirmation<ExtensionContext>(context, options),
): Promise<{ block: boolean; reason?: string }> {
  if (!mode || !isGitPushCommand(command)) return { block: false };
  if (mode === "vibe-solo" || mode === "vibe-quick") return { block: false };
  if (!ctx.hasUI || (ctx.mode !== "tui" && ctx.mode !== "rpc")) {
    return { block: true, reason: `git push blocked in ${mode} mode because confirmation UI is unavailable` };
  }
  try {
    const result = await confirm(ctx, {
      title: `Confirm git push (${mode})`,
      message: `Allow this exact command?\n\n${sanitizeTerminalText(JSON.stringify(command))}`,
      confirmLabel: "Allow push",
      cancelLabel: "Deny",
      signal: owner.signal,
      isCurrent: owner.isCurrent,
    });
    return result.kind === "confirmed"
      ? { block: false }
      : { block: true, reason: `git push denied in ${mode} mode (${result.kind === "closed" ? result.reason : result.kind})` };
  } catch {
    return { block: true, reason: `git push blocked in ${mode} mode because confirmation failed` };
  }
}

interface ModeMenuState {
  mode: WorkMode | undefined;
  apply(mode: WorkMode | undefined): void;
}

export function createModeMenu(): MenuDefinition<ModeMenuState, "choice", "select"> {
  return defineMenu<ModeMenuState, "choice", "select">({
    start: "choice",
    screens: {
      choice: ({ state }) => ({
        kind: "choice",
        title: "Session Work Mode",
        lines: [`Current: ${state.mode ?? "off"}`],
        items: [
          ...WORK_MODES.map((mode) => ({ id: mode, label: mode, description: MODE_DESCRIPTIONS[mode], details: [WORK_MODE_CONTRACTS[mode]] })),
          { id: "off", label: "off", description: "Clear the session work mode.", details: ["No work-mode prompt contract is injected."] },
        ],
        action: "select",
        currentItemId: state.mode ?? "off",
        initialItemId: state.mode ?? "off",
        enableSearch: true,
        viewportSize: 7,
        hint: "close",
      }),
    },
    actions: {
      select: async ({ state, itemId }) => {
        const parsed = parseWorkMode(itemId);
        if (!parsed) return { kind: "rejected" };
        state.apply(parsed === "off" ? undefined : parsed);
        return { kind: "close" };
      },
    },
  });
}

export function registerWorkMode(pi: ExtensionAPI, getOwner: () => SessionOwner | undefined): { getMode: () => WorkMode | undefined } {
  let selected: WorkMode | undefined;
  let lastContext: ExtensionContext | undefined;
  const publishStatus = (ctx: ExtensionContext) => ctx.ui.setStatus(WORK_MODE_STATUS_KEY, selected ? `mode ${selected}` : undefined);
  const selectMode = (mode: WorkMode | undefined, ctx: ExtensionContext) => {
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
          ctx.ui.notify(`Unknown mode: ${oneLine(argument)}`, "error");
          return;
        }
        selectMode(mode === "off" ? undefined : mode, ctx);
        return;
      }
      if (ctx.mode === "print" || ctx.mode === "json") {
        throw new Error(`/mode without an argument is unsupported in ${ctx.mode} mode; use /mode <name>.`);
      }
      const owner = getOwner();
      if (!owner) {
        ctx.ui.notify("/mode is unavailable because the session is closing.", "error");
        return;
      }
      await runMenu(ctx, createModeMenu(), {
        getState: () => ({ mode: selected, apply: (mode) => selectMode(mode, ctx) }),
        signal: owner.signal,
        isCurrent: owner.isCurrent,
        onError: (_context, error) => ctx.ui.notify(`Mode menu failed: ${oneLine(error instanceof Error ? error.message : error)}`, "error"),
        onUnsupportedMode: (_context, mode) => ctx.ui.notify(`/mode is unsupported in ${mode} mode.`, "error"),
      });
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
  pi.on("session_before_switch", (event) => {
    if (event.reason === "new") snapshotLinkedParent();
  });
  pi.on("session_before_fork", snapshotLinkedParent);
  pi.on("before_agent_start", (event) => {
    if (selected) return { systemPrompt: `${event.systemPrompt ?? ""}\n\n${workModePrompt(selected)}` };
  });
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return;
    const owner = getOwner();
    if (!owner && selected && isGitPushCommand(String(event.input?.command ?? ""))) {
      return { block: true, reason: "git push blocked because session confirmation ownership is unavailable" };
    }
    if (!owner) return;
    const result = await guardGitPush(String(event.input?.command ?? ""), selected, ctx, owner);
    if (!result.block) return;
    return result.reason ? { block: true, reason: result.reason } : { block: true };
  });
  pi.on("user_bash", async (event, ctx) => {
    const owner = getOwner();
    if (!owner && selected && isGitPushCommand(event.command ?? "")) {
      return { result: { output: "git push blocked because session confirmation ownership is unavailable", exitCode: 1, cancelled: false, truncated: false } };
    }
    if (!owner) return;
    const result = await guardGitPush(event.command ?? "", selected, ctx, owner);
    if (!result.block) return;
    return { result: { output: result.reason ?? "git push blocked", exitCode: 1, cancelled: false, truncated: false } };
  });
  pi.on("session_shutdown", () => {
    lastContext?.ui.setStatus(WORK_MODE_STATUS_KEY, undefined);
    lastContext = undefined;
    selected = undefined;
  });
  return { getMode: () => selected };
}

export function dashboardDataFromContext(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  telemetry: Readonly<TelemetrySnapshot>,
  activity: string,
  statuses: ReadonlyArray<[string, string]>,
): DashboardData {
  const active = new Set(pi.getActiveTools());
  const allTools = pi.getAllTools();
  const commands = pi.getCommands();
  const messages = ctx.sessionManager.getBranch().flatMap((entry) => entry.type === "message" ? [entry.message] : []);
  const cache = promptCacheTelemetry(messages, ctx.model?.provider, ctx.model?.id);
  const usage = ctx.getContextUsage();
  const context = `${usage?.tokens ?? "?"}/${usage?.contextWindow ?? ctx.model?.contextWindow ?? "?"}`;
  return {
    runtime: {
      mode: ctx.mode,
      activity,
      provider: ctx.model?.provider ?? "none",
      model: ctx.model?.id ?? "none",
      thinking: pi.getThinkingLevel(),
      projectTrusted: ctx.isProjectTrusted(),
    },
    session: {
      id: ctx.sessionManager.getSessionId(),
      name: ctx.sessionManager.getSessionName() ?? "unnamed",
      file: ctx.sessionManager.getSessionFile() ?? "ephemeral",
      cwd: ctx.cwd,
      entries: ctx.sessionManager.getEntries().length,
      branchEntries: ctx.sessionManager.getBranch().length,
      pending: ctx.hasPendingMessages(),
    },
    telemetry,
    context,
    cache: cache?.text ?? "not reported",
    providerUsage: statuses.find(([key]) => key === "usage")?.[1] ?? "not reported",
    statuses,
    tools: allTools.map((tool) => ({
      name: tool.name,
      active: active.has(tool.name),
      description: tool.description,
      source: tool.sourceInfo.source,
      path: tool.sourceInfo.path,
    })).sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name)),
    commands: commands.map((command) => ({
      name: command.name,
      description: command.description ?? "",
      source: command.source,
      scope: command.sourceInfo.scope,
      origin: command.sourceInfo.origin,
      path: command.sourceInfo.path,
    })),
  };
}
