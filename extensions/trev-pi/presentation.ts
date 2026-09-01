import { basename } from "node:path";
import type {
  ExtensionContext,
  KeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  CustomEditor,
  VERSION,
} from "@earendil-works/pi-coding-agent";
import type { Component, EditorTheme, TUI } from "@earendil-works/pi-tui";
import {
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
  formatInteractionHints,
  HorizontalRule,
  sanitizeTerminalText,
} from "@narumitw/pi-tui-kit";
import type { GitTelemetry, LoadState, PullRequestTelemetry, TelemetrySnapshot } from "./state.ts";

const ANSI_PATTERN = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

export function oneLine(value: unknown): string {
  return sanitizeTerminalText(String(value ?? "")).replace(/\s+/gu, " ").trim();
}

export function shortenPath(path: string, home = process.env.HOME): string {
  if (!path) return ".";
  if (home && path === home) return "~";
  return home && path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

export function compactNumber(value: number): string {
  if (value < 1_000) return String(value);
  if (value < 10_000) return `${(value / 1_000).toFixed(1)}k`;
  if (value < 1_000_000) return `${Math.round(value / 1_000)}k`;
  if (value < 10_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  return `${Math.round(value / 1_000_000)}M`;
}

export function contextTelemetry(tokens: number | null | undefined, window: number | undefined): string {
  const value = (number: number) => compactNumber(number).replace(/\.0([kM])$/u, "$1");
  return `${tokens == null ? "?" : value(tokens)}/${window ? value(window) : "?"}`;
}

export interface AssistantUsageLike {
  role: string;
  provider?: string;
  model?: string;
  stopReason?: string;
  usage?: {
    cacheRead?: number;
    cacheWrite?: number;
  };
}

export interface PromptCacheTelemetry {
  text: string;
  empty: boolean;
}

function cacheTokens(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

export function promptCacheTelemetry(
  messages: readonly AssistantUsageLike[],
  provider: string | undefined,
  model: string | undefined,
): PromptCacheTelemetry | undefined {
  if (!provider || !model) return undefined;
  let latest: { read: number; write: number } | undefined;
  let observed = false;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (
      message?.role !== "assistant" || message.provider !== provider || message.model !== model ||
      message.stopReason === "pending" || message.stopReason === "deferred"
    ) continue;
    const read = cacheTokens(message.usage?.cacheRead);
    const write = cacheTokens(message.usage?.cacheWrite);
    latest ??= { read, write };
    if (read > 0 || write > 0) observed = true;
  }
  if (!latest || !observed) return undefined;
  const values = [
    ...(latest.read > 0 || latest.write === 0 ? [`${compactNumber(latest.read)}r`] : []),
    ...(latest.write > 0 ? [`${compactNumber(latest.write)}w`] : []),
  ];
  return { text: values.join("/"), empty: latest.read === 0 && latest.write === 0 };
}

const STATUS_RANKS: Record<string, number> = {
  usage: 0,
  goal: 1,
  "work-mode": 2,
  organizer: 3,
  ollama: 3,
  caveman: 8,
  ponytail: 8,
};

export function statusRank(name: string): number {
  return STATUS_RANKS[name] ?? 5;
}

export function compactPluginStatus(name: string, status: string): string {
  const plain = oneLine(stripAnsi(status));
  if (name === "goal") {
    if (/^complete\b/iu.test(plain)) return "goal ✓";
    const counter = plain.match(/automatic (\d+\/\d+|Unlimited)/iu)?.[1];
    const state = plain.match(/^(active|queued|waiting|paused|blocked|usage|budget)/iu)?.[1];
    if (!counter && !state) return `goal ${plain}`;
    const label = state && state.toLowerCase() !== "active" ? ` ${state.toLowerCase()}` : "";
    return `goal${label}${counter ? ` ${counter}` : ""}`;
  }
  if (name === "work-mode") return plain.replace(/^mode\s+/iu, "mode ");
  const level = name === "caveman"
    ? plain.match(/caveman level:\s*(\S+)/iu)?.[1]?.toLowerCase()
    : name === "ponytail"
      ? plain.match(/\b(lite|full|ultra)\b/iu)?.[1]?.toLowerCase()
      : undefined;
  if (level) {
    const count = ({ lite: 1, full: 2, ultra: 3 } as Record<string, number>)[level];
    return `${name} ${count ? "▰".repeat(count) : level}`;
  }
  return name === "usage" ? plain : `${oneLine(name)} ${plain}`.trim();
}

export function shouldRefreshGit(toolName: string, input: Record<string, unknown> | undefined, isError: boolean): boolean {
  if (isError) return false;
  if (toolName === "edit" || toolName === "write") return true;
  return toolName === "bash" && /\bgit\b/u.test(oneLine(input?.command));
}

export function splitResourceCommands(commands: Array<{ name: string; source: string }>): {
  skills: string[];
  commands: string[];
  prompts: string[];
} {
  const uniqueSorted = (values: string[]) => [...new Set(values.map(oneLine))].sort((a, b) => a.localeCompare(b));
  return {
    skills: uniqueSorted(commands.filter((command) => command.source === "skill").map((command) => command.name.replace(/^skill:/u, ""))),
    commands: uniqueSorted(commands.filter((command) => command.source === "extension").map((command) => `/${command.name}`)),
    prompts: uniqueSorted(commands.filter((command) => command.source === "prompt").map((command) => `/${command.name}`)),
  };
}

export interface AdaptiveSegment {
  id: string;
  variants: readonly string[];
  priority: number;
}

/** Shrink and then omit whole semantic segments; never partially truncate one. */
export function fitAdaptiveSegments(
  segments: readonly AdaptiveSegment[],
  width: number,
  separator = " · ",
  measure: (text: string) => number = visibleWidth,
): string {
  const available = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
  if (available === 0) return "";
  const kept = segments.flatMap((segment, order) => {
    const variant = segment.variants.findIndex((value) => measure(value) <= available);
    return variant < 0 ? [] : [{ segment, order, variant }];
  });
  const total = () => kept.reduce(
    (sum, item, index) => sum + measure(item.segment.variants[item.variant] ?? "") + (index ? measure(separator) : 0),
    0,
  );
  while (kept.length && total() > available) {
    const shrinkable = kept
      .filter((item) => item.variant + 1 < item.segment.variants.length)
      .sort((a, b) => a.segment.priority - b.segment.priority || b.order - a.order)[0];
    if (shrinkable) {
      shrinkable.variant += 1;
      continue;
    }
    const removable = [...kept].sort((a, b) => a.segment.priority - b.segment.priority || b.order - a.order)[0];
    if (!removable) break;
    kept.splice(kept.indexOf(removable), 1);
  }
  const line = kept.map((item) => item.segment.variants[item.variant] ?? "").join(separator);
  return measure(line) <= available ? line : "";
}

export interface FooterView {
  now: number;
  activity: "active" | "waiting" | "idle";
  activitySince: number | undefined;
  frame: string;
  provider: string;
  model: string;
  thinking: string;
  context: string;
  cache: PromptCacheTelemetry | undefined;
  providerUsage: string | undefined;
  queued: boolean;
  project: string;
  session: string;
  telemetry: Readonly<TelemetrySnapshot>;
  statuses: ReadonlyArray<[string, string]>;
}

function elapsedLabel(now: number, since: number | undefined): string {
  if (since === undefined) return "";
  return `${Math.max(0, Math.floor((now - since) / 1_000))}s`;
}

function gitSegments(state: LoadState<GitTelemetry>, theme: Theme): AdaptiveSegment[] {
  if (state.kind === "ready") {
    const git = state.value;
    const movement = `${git.ahead ? ` ↑${git.ahead}` : ""}${git.behind ? ` ↓${git.behind}` : ""}`;
    const changes = [
      git.staged ? `S${git.staged}` : "",
      git.unstaged ? `M${git.unstaged}` : "",
      git.untracked ? `?${git.untracked}` : "",
      git.conflicted ? `!${git.conflicted}` : "",
    ].filter(Boolean).join(" ") || "clean";
    return [
      {
        id: "git-branch",
        priority: 88,
        variants: [
          theme.fg("muted", ` ${oneLine(git.branch)}${movement}`),
          theme.fg("muted", `git ${oneLine(git.branch)}${movement}`),
          theme.fg("muted", ` ${oneLine(git.branch)}`),
        ],
      },
      {
        id: "git-changes",
        priority: 82,
        variants: [theme.fg(git.conflicted ? "error" : git.changed ? "warning" : "dim", `git ${changes}`), theme.fg(git.changed ? "warning" : "dim", changes)],
      },
    ];
  }
  if (state.kind === "empty") return [{ id: "git", priority: 50, variants: [theme.fg("dim", "git none"), theme.fg("dim", "git —")] }];
  if (state.kind === "error") return [{ id: "git", priority: 85, variants: [theme.fg("error", "git error"), theme.fg("error", "git !")] }];
  return [{ id: "git", priority: 30, variants: [theme.fg("dim", "git loading"), theme.fg("dim", "git …")] }];
}

function pullRequestSegments(state: LoadState<PullRequestTelemetry>, theme: Theme): AdaptiveSegment[] {
  if (state.kind === "ready") {
    const pr = state.value;
    const checkTone = pr.checks.failure ? "error" : pr.checks.pending ? "warning" : "success";
    const checkValue = pr.checks.total
      ? `${pr.checks.success}/${pr.checks.total}${pr.checks.pending ? ` pending ${pr.checks.pending}` : ""}${pr.checks.failure ? ` failed ${pr.checks.failure}` : ""}`
      : "none";
    return [
      {
        id: "pr",
        priority: 76,
        variants: [theme.fg(pr.isDraft ? "warning" : "muted", `PR #${pr.number} ${pr.isDraft ? "draft" : oneLine(pr.state).toLowerCase()}`), theme.fg(pr.isDraft ? "warning" : "muted", `PR #${pr.number}`)],
      },
      { id: "checks", priority: 72, variants: [theme.fg(checkTone, `checks ${checkValue}`), theme.fg(checkTone, `CI ${pr.checks.failure ? "!" : pr.checks.pending ? "…" : pr.checks.total ? "✓" : "—"}`)] },
      { id: "review", priority: 68, variants: [theme.fg(pr.reviewDecision === "CHANGES_REQUESTED" ? "error" : pr.reviewDecision === "APPROVED" ? "success" : "dim", `review ${oneLine(pr.reviewDecision).toLowerCase()}`), theme.fg("dim", `review ${pr.reviewDecision === "APPROVED" ? "✓" : pr.reviewDecision === "CHANGES_REQUESTED" ? "!" : "—"}`)] },
    ];
  }
  if (state.kind === "empty") return [{ id: "pr", priority: 45, variants: [theme.fg("dim", "PR none"), theme.fg("dim", "PR —")] }];
  if (state.kind === "error") return [{ id: "pr", priority: 74, variants: [theme.fg("error", "GitHub PR error"), theme.fg("error", "PR !")] }];
  return [{ id: "pr", priority: 25, variants: [theme.fg("dim", "PR loading"), theme.fg("dim", "PR …")] }];
}

export function buildFooterRows(view: FooterView, width: number, theme: Theme): [string, string] {
  const elapsed = elapsedLabel(view.now, view.activitySince);
  const activity = view.activity === "active"
    ? [theme.fg("accent", `${view.frame} active${elapsed ? ` ${elapsed}` : ""}`), theme.fg("accent", `${view.frame}${elapsed ? ` ${elapsed}` : ""}`), theme.fg("accent", view.frame)]
    : view.activity === "waiting"
      ? [theme.fg("warning", `wait${elapsed ? ` ${elapsed}` : ""}`), theme.fg("warning", "wait"), theme.fg("warning", "w")]
      : [theme.fg("dim", "idle"), theme.fg("dim", "·")];
  const runtime: AdaptiveSegment[] = [
    { id: "activity", priority: 100, variants: activity },
    { id: "model", priority: 96, variants: [theme.fg("text", `󰚩 ${oneLine(view.provider)}/${oneLine(view.model)}`), theme.fg("text", `󰚩 ${oneLine(view.model)}`), theme.fg("text", "󰚩")] },
    { id: "thinking", priority: 74, variants: [theme.fg("muted", `thinking ${oneLine(view.thinking)}`), theme.fg("muted", `t:${oneLine(view.thinking).slice(0, 1)}`)] },
    { id: "context", priority: 90, variants: [theme.fg("muted", `context ${oneLine(view.context)}`), theme.fg("muted", `ctx ${oneLine(view.context)}`), theme.fg("muted", `󰍛${oneLine(view.context).split("/")[0] ?? "?"}`)] },
    ...(view.cache ? [{ id: "cache", priority: 62, variants: [theme.fg(view.cache.empty ? "warning" : "dim", `cache ${oneLine(view.cache.text)}`), theme.fg("dim", `󰒍 ${oneLine(view.cache.text)}`)] } satisfies AdaptiveSegment] : []),
    ...(view.providerUsage ? [{ id: "usage", priority: 58, variants: [theme.fg("dim", `usage ${oneLine(view.providerUsage)}`), theme.fg("dim", `usage ${oneLine(view.providerUsage).split(" · ")[0] ?? ""}`)] } satisfies AdaptiveSegment] : []),
    ...(view.queued ? [{ id: "queue", priority: 80, variants: [theme.fg("warning", "queue pending"), theme.fg("warning", "queued"), theme.fg("warning", "q")] } satisfies AdaptiveSegment] : []),
  ];

  const notifications: AdaptiveSegment[] = view.telemetry.notifications.kind === "ready"
    ? [{ id: "notifications", priority: 64, variants: [theme.fg(view.telemetry.notifications.value ? "warning" : "dim", ` notifications ${view.telemetry.notifications.value}`), theme.fg(view.telemetry.notifications.value ? "warning" : "dim", ` ${view.telemetry.notifications.value}`)] }]
    : view.telemetry.notifications.kind === "error"
      ? [{ id: "notifications", priority: 70, variants: [theme.fg("error", " notifications error"), theme.fg("error", " !")] }]
      : [{ id: "notifications", priority: 20, variants: [theme.fg("dim", " loading"), theme.fg("dim", " …")] }];
  const pluginSegments = view.statuses
    .filter(([name]) => name !== "usage")
    .map(([name, value], index): AdaptiveSegment => ({
      id: `status-${name}`,
      priority: Math.max(20, 55 - index),
      variants: [theme.fg("dim", compactPluginStatus(name, value))],
    }));
  const workspace: AdaptiveSegment[] = [
    { id: "project", priority: 94, variants: [theme.fg("text", ` ${oneLine(view.project)}`), theme.fg("text", oneLine(view.project)), theme.fg("text", "")] },
    { id: "session", priority: 86, variants: [theme.fg("muted", `session ${oneLine(view.session)}`), theme.fg("muted", `s:${oneLine(view.session)}`)] },
    ...gitSegments(view.telemetry.git, theme),
    ...pullRequestSegments(view.telemetry.pullRequest, theme),
    ...notifications,
    ...pluginSegments,
  ];
  const separator = theme.fg("dim", " · ");
  return [fitAdaptiveSegments(runtime, width, separator), fitAdaptiveSegments(workspace, width, separator)];
}

export interface HeaderData {
  project: string;
  cwd: string;
  session: string;
  sessionId: string;
  provider: string;
  model: string;
  thinking: string;
  trusted: boolean;
  telemetry: Readonly<TelemetrySnapshot>;
  skills: string[];
  commands: string[];
  prompts: string[];
  tools: string[];
}

function headerRepo(state: LoadState<GitTelemetry>): string {
  if (state.kind === "ready") {
    const git = state.value;
    return `repo ${git.branch} · ${git.changed ? `${git.changed} changed` : "clean"} · ↑${git.ahead} ↓${git.behind}`;
  }
  if (state.kind === "empty") return "repo none";
  if (state.kind === "error") return "repo collector error";
  return "repo loading";
}

function inventoryLines(label: string, values: readonly string[], width: number, theme: Theme, expanded: boolean): string[] {
  if (width <= 0) return [];
  const shown = expanded ? values : values.slice(0, 6);
  const suffix = values.length > shown.length ? " · …" : "";
  const prefix = `${label.padEnd(10)} `;
  const content = shown.length ? shown.map(oneLine).join(" · ") + suffix : "none";
  const wrapped = wrapTextWithAnsi(theme.fg("text", content), Math.max(1, width - visibleWidth(prefix)));
  return wrapped.map((line, index) => truncateToWidth(
    `${index === 0 ? theme.fg("muted", prefix) : " ".repeat(visibleWidth(prefix))}${line}`,
    width,
    "…",
  ));
}

export class StartupDashboard implements Component {
  private expanded = false;

  constructor(
    private readonly theme: Theme,
    private readonly keybindings: Pick<KeybindingsManager, "getKeys">,
    private readonly getData: () => HeaderData,
    private readonly requestRender: () => void,
  ) {}

  setExpanded(expanded: boolean): void {
    this.expanded = expanded;
    this.requestRender();
  }

  invalidate(): void {}

  render(rawWidth: number): string[] {
    const width = Number.isFinite(rawWidth) ? Math.max(0, Math.floor(rawWidth)) : 0;
    if (width === 0) return [];
    const data = this.getData();
    const counts = `${data.skills.length} skills · ${data.commands.length} commands · ${data.prompts.length} prompts · ${data.tools.length} tools`;
    const line = (text: string) => truncateToWidth(text, width, "…");
    const rule = new HorizontalRule({
      label: `π pi v${VERSION}`,
      paddingX: width > 8 ? 1 : 0,
      ruleStyle: (text) => this.theme.fg("borderMuted", text),
      labelStyle: (text) => this.theme.fg("accent", this.theme.bold(text)),
    }).render(width);
    const lines = [
      ...rule,
      line(`${this.theme.fg("accent", "session")} ${this.theme.fg("text", oneLine(data.session))} ${this.theme.fg("dim", oneLine(data.sessionId))}`),
      line(`${this.theme.fg("accent", "project")} ${this.theme.fg("text", oneLine(data.project))} ${this.theme.fg("dim", oneLine(shortenPath(data.cwd)))} ${this.theme.fg(data.trusted ? "success" : "warning", data.trusted ? "trusted" : "untrusted")}`),
      line(`${this.theme.fg("accent", "model")} ${this.theme.fg("text", `${oneLine(data.provider)}/${oneLine(data.model)}`)} ${this.theme.fg("dim", `thinking ${oneLine(data.thinking)}`)}`),
      line(this.theme.fg(data.telemetry.git.kind === "error" ? "error" : "muted", headerRepo(data.telemetry.git))),
      line(this.theme.fg("dim", counts)),
    ];
    if (width >= 20) {
      lines.push(...inventoryLines("skills", data.skills, width, this.theme, this.expanded));
      lines.push(...inventoryLines("commands", data.commands, width, this.theme, this.expanded));
      if (this.expanded) {
        lines.push(...inventoryLines("prompts", data.prompts, width, this.theme, true));
        lines.push(...inventoryLines("tools", data.tools, width, this.theme, true));
      }
    }
    const hints = formatInteractionHints(this.keybindings, [
      { bindings: ["app.tools.expand"], label: this.expanded ? "compact inventories" : "expand inventories" },
      { bindings: ["app.interrupt"], label: "interrupt" },
      { bindings: ["app.thinking.toggle"], label: "reasoning" },
      { bindings: ["app.model.select"], label: "model" },
      { keys: ["/"], label: "commands" },
      { keys: ["!"], label: "shell" },
    ]);
    lines.push(...wrapTextWithAnsi(this.theme.fg("dim", hints), width).map((value) => truncateToWidth(value, width, "…")));
    lines.push(...new HorizontalRule({ ruleStyle: (text) => this.theme.fg("borderMuted", text) }).render(width));
    return lines;
  }
}

export interface EditorView {
  activity: "active" | "waiting" | "idle";
  frame: string;
  error: boolean;
  queued: boolean;
  thinking: string;
}

export function fitBorder(
  left: string,
  right: string,
  width: number,
  border: (text: string) => string,
  fill: (text: string) => string = border,
): string {
  const available = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
  if (available === 0) return "";
  if (available === 1) return border("─");
  let leftText = left;
  let rightText = right;
  while (2 + visibleWidth(leftText) + visibleWidth(rightText) + 1 > available && visibleWidth(rightText) > 0) {
    rightText = truncateToWidth(rightText, Math.max(0, visibleWidth(rightText) - 1), "");
  }
  while (2 + visibleWidth(leftText) + visibleWidth(rightText) + 1 > available && visibleWidth(leftText) > 0) {
    leftText = truncateToWidth(leftText, Math.max(0, visibleWidth(leftText) - 1), "");
  }
  const gap = Math.max(0, available - 2 - visibleWidth(leftText) - visibleWidth(rightText));
  return `${border("─")}${leftText}${fill("─".repeat(gap))}${rightText}${border("─")}`;
}

function paintPanel(line: string, width: number, background: (text: string) => string): string {
  const clipped = truncateToWidth(line, width, "");
  const padded = `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
  const pieces = padded.split(/(\x1b\[(?:0|49)m)/gu);
  return pieces.map((piece) => /^\x1b\[(?:0|49)m$/u.test(piece) ? piece : background(piece)).join("");
}

export class TrevEditor extends CustomEditor {
  constructor(
    tui: TUI,
    editorTheme: EditorTheme,
    keybindings: KeybindingsManager,
    private readonly panelTheme: Theme,
    private readonly getView: () => EditorView,
  ) {
    super(tui, editorTheme, keybindings, { paddingX: 0 });
  }

  override render(rawWidth: number): string[] {
    const width = Number.isFinite(rawWidth) ? Math.max(0, Math.floor(rawWidth)) : 0;
    if (width === 0) return [];
    const view = this.getView();
    const lines = super.render(width);
    if (!lines.length) return lines;
    const text = this.getText();
    const shell = text.trimStart().startsWith("!");
    const tone = view.error ? "error" : shell ? "bashMode" : view.activity === "active" ? "accent" : view.activity === "waiting" ? "warning" : "muted";
    const state = view.error
      ? " ERROR "
      : view.activity === "active"
        ? ` ${view.frame} ACTIVE `
        : view.activity === "waiting"
          ? " WAITING "
          : shell
            ? " SHELL "
            : " READY ";
    const right = `${shell ? "shell" : `thinking ${oneLine(view.thinking)}`}${view.queued ? " · queued" : ""}`;
    lines[0] = fitBorder(
      this.panelTheme.fg(tone, state),
      this.panelTheme.fg(view.queued ? "warning" : "dim", ` ${right} `),
      width,
      (value) => this.panelTheme.fg("borderMuted", value),
      (value) => this.panelTheme.fg(tone, value),
    );
    if (!text && lines.length > 1) {
      const cursorPattern = /(\x1b\[7m \x1b\[(?:0|27)m)/u;
      const firstContent = lines.findIndex((value, index) => index > 0 && cursorPattern.test(value));
      if (firstContent >= 0) {
        lines[firstContent] = lines[firstContent]!.replace(cursorPattern, `$1${this.panelTheme.fg("dim", "Ask Pi…")}`);
      }
    }
    return lines.map((line) => paintPanel(line, width, (value) => this.panelTheme.bg("selectedBg", value)));
  }
}

export function projectName(ctx: Pick<ExtensionContext, "cwd">): string {
  return oneLine(basename(ctx.cwd) || shortenPath(ctx.cwd));
}
