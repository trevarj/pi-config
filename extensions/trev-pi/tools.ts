import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type ExtensionAPI,
  type ExtensionContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { Container, type Component, truncateToWidth } from "@earendil-works/pi-tui";
import { sanitizeTerminalDocument } from "@narumitw/pi-tui-kit/terminal-document";
import { oneLine, shortenPath } from "./presentation.ts";

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

export class AnimationClock {
  private readonly listeners = new Map<string, () => void>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private frameIndex = 0;

  constructor(
    private readonly intervalMs = 100,
    private readonly setTimer: typeof setInterval = setInterval,
    private readonly clearTimer: typeof clearInterval = clearInterval,
  ) {}

  get frame(): string {
    return SPINNER_FRAMES[this.frameIndex] ?? SPINNER_FRAMES[0];
  }

  start(key: string, listener: () => void): void {
    this.listeners.set(key, listener);
    if (this.timer) return;
    this.timer = this.setTimer(() => {
      this.frameIndex = (this.frameIndex + 1) % SPINNER_FRAMES.length;
      for (const callback of [...this.listeners.values()]) callback();
    }, this.intervalMs);
  }

  stop(key: string): void {
    this.listeners.delete(key);
    if (this.listeners.size || !this.timer) return;
    this.clearTimer(this.timer);
    this.timer = undefined;
  }

  clear(): void {
    this.listeners.clear();
    if (this.timer) this.clearTimer(this.timer);
    this.timer = undefined;
    this.frameIndex = 0;
  }

  get activeCount(): number {
    return this.listeners.size;
  }
}

/** Shared by the editor, built-ins, and subagents-ui in one Pi process. */
export const sharedAnimationClock = new AnimationClock();

export type BuiltInToolName = "bash" | "read" | "edit" | "write" | "grep" | "find" | "ls";
export type RenderTone = "success" | "neutral" | "warning" | "error";

export interface ResultBlock {
  type: string;
  text?: string;
}

export interface ToolResultLike {
  content: ResultBlock[];
  details?: unknown;
}

export interface ToolSummary {
  text: string;
  tone: RenderTone;
}

const TOOL_ICONS: Record<BuiltInToolName, string> = {
  bash: "",
  read: "󰈙",
  edit: "",
  write: "󰆓",
  grep: "",
  find: "󰱼",
  ls: "",
};
const TOOL_NAMES = Object.keys(TOOL_ICONS) as BuiltInToolName[];

function textOutput(result: ToolResultLike): string {
  return result.content.filter((block) => block.type === "text").map((block) => block.text ?? "").join("\n");
}

function countLines(text: string): number {
  const trimmed = text.replace(/\s+$/u, "");
  return trimmed ? trimmed.split("\n").length : 0;
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function diffStats(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) added += 1;
    if (line.startsWith("-") && !line.startsWith("---")) removed += 1;
  }
  return { added, removed };
}

function warningOutput(output: string): boolean {
  return /\b(cancelled|canceled|timed out|timeout|aborted|interrupted)\b/iu.test(output);
}

export function toolSubject(name: BuiltInToolName, args: Record<string, unknown>): string {
  const path = shortenPath(oneLine(args.path ?? args.file_path ?? "."));
  switch (name) {
    case "bash":
      return oneLine(args.command) || "command";
    case "read": {
      const offset = typeof args.offset === "number" ? args.offset : undefined;
      const limit = typeof args.limit === "number" ? args.limit : undefined;
      const range = offset !== undefined || limit !== undefined
        ? `:${offset ?? 1}${limit !== undefined ? `-${(offset ?? 1) + limit - 1}` : ""}`
        : "";
      return `${path}${range}`;
    }
    case "edit":
    case "write":
    case "ls":
      return path;
    case "grep": {
      const pattern = oneLine(args.pattern);
      const root = shortenPath(oneLine(args.path ?? "."));
      const glob = oneLine(args.glob);
      return `/${pattern}/ in ${root}${glob ? ` · ${glob}` : ""}`;
    }
    case "find":
      return `${oneLine(args.pattern)} in ${shortenPath(oneLine(args.path ?? "."))}`;
  }
}

export function toolSummary(
  name: BuiltInToolName,
  args: Record<string, unknown>,
  result: ToolResultLike,
  isError: boolean,
): ToolSummary {
  const output = textOutput(result);
  if (isError) {
    const text = oneLine(output.split("\n", 1)[0]) || "failed";
    return { text, tone: warningOutput(output) ? "warning" : "error" };
  }
  if (name === "grep" && /^No matches found\s*$/iu.test(output)) return { text: "no matches", tone: "neutral" };
  switch (name) {
    case "read":
      if (result.content.some((block) => block.type === "image")) return { text: "image", tone: "success" };
      return { text: plural(countLines(output), "line"), tone: countLines(output) ? "success" : "neutral" };
    case "grep": {
      const count = countLines(output);
      return { text: plural(count, "result"), tone: count ? "success" : "neutral" };
    }
    case "find": {
      const count = /^No files found matching pattern\s*$/iu.test(output) ? 0 : countLines(output);
      return { text: plural(count, "file"), tone: count ? "success" : "neutral" };
    }
    case "ls": {
      const count = /^\(empty directory\)\s*$/iu.test(output) ? 0 : countLines(output);
      return { text: plural(count, "entry", "entries"), tone: count ? "success" : "neutral" };
    }
    case "bash": {
      const lines = countLines(output);
      return { text: lines ? plural(lines, "line") : "done", tone: "success" };
    }
    case "edit": {
      const details = result.details as { diff?: unknown } | undefined;
      const stats = diffStats(typeof details?.diff === "string" ? details.diff : "");
      return { text: `+${stats.added} −${stats.removed}`, tone: stats.added || stats.removed ? "success" : "neutral" };
    }
    case "write": {
      const content = typeof args.content === "string" ? args.content : "";
      return { text: plural(countLines(content), "line"), tone: "success" };
    }
  }
}

export function partialProgress(result: unknown): string | undefined {
  const content = result && typeof result === "object" ? (result as { content?: unknown }).content : undefined;
  if (!Array.isArray(content)) return undefined;
  const document = sanitizeTerminalDocument(content
    .filter((item) => item && typeof item === "object" && (item as { type?: unknown }).type === "text")
    .map((item) => String((item as { text?: unknown }).text ?? ""))
    .join("\n"));
  const lines = document.split("\n").map(oneLine).filter(Boolean);
  const useful = lines.at(-1);
  return useful ? useful.slice(0, 180) : undefined;
}

interface ActivityRecord {
  name: string;
  startedAt: number;
  endedAt?: number;
  progress?: string;
  invalidate?: () => void;
}

export class ToolActivityController {
  private readonly records = new Map<string, ActivityRecord>();

  constructor(
    private readonly clock = sharedAnimationClock,
    private readonly now: () => number = Date.now,
  ) {}

  start(id: string, name: string): void {
    const record = this.records.get(id) ?? { name, startedAt: this.now() };
    record.name = name;
    this.records.set(id, record);
    this.clock.start(`tool:${id}`, () => record.invalidate?.());
  }

  update(id: string, name: string, partial: unknown): void {
    this.start(id, name);
    const record = this.records.get(id);
    const progress = partialProgress(partial);
    if (record && progress !== undefined) record.progress = progress;
    else if (record) delete record.progress;
  }

  attach(id: string, name: string, invalidate: () => void): ActivityRecord {
    this.start(id, name);
    const record = this.records.get(id)!;
    record.invalidate = invalidate;
    return record;
  }

  end(id: string, discard = false): void {
    const record = this.records.get(id);
    if (record) record.endedAt ??= this.now();
    this.clock.stop(`tool:${id}`);
    if (discard) this.records.delete(id);
  }

  finish(id: string): ActivityRecord | undefined {
    this.end(id);
    const record = this.records.get(id);
    this.records.delete(id);
    return record;
  }

  get(id: string): ActivityRecord | undefined {
    return this.records.get(id);
  }

  clear(): void {
    for (const id of this.records.keys()) this.clock.stop(`tool:${id}`);
    this.records.clear();
  }
}

class SingleLine implements Component {
  constructor(private readonly value: string | (() => string)) {}

  render(width: number): string[] {
    const value = typeof this.value === "function" ? this.value() : this.value;
    return width > 0 ? [truncateToWidth(value, width, "…")] : [];
  }

  invalidate(): void {}
}

function emptyComponent(): Component {
  return new Container();
}

function elapsed(startedAt: number, endedAt = Date.now()): string {
  const milliseconds = Math.max(0, endedAt - startedAt);
  if (milliseconds < 1_000) return `${milliseconds}ms`;
  return `${(milliseconds / 1_000).toFixed(milliseconds < 10_000 ? 1 : 0)}s`;
}

function toneStyle(tone: RenderTone): { glyph: string; color: "success" | "dim" | "warning" | "error" } {
  if (tone === "success") return { glyph: "✓", color: "success" };
  if (tone === "warning") return { glyph: "!", color: "warning" };
  if (tone === "error") return { glyph: "✗", color: "error" };
  return { glyph: "○", color: "dim" };
}

export function setupToolRenderers(
  pi: ExtensionAPI,
  activity: ToolActivityController,
): { clear(): void } {
  const factories = {
    bash: createBashToolDefinition,
    read: createReadToolDefinition,
    edit: createEditToolDefinition,
    write: createWriteToolDefinition,
    grep: createGrepToolDefinition,
    find: createFindToolDefinition,
    ls: createLsToolDefinition,
  } as const;
  const cache = new Map<string, Record<BuiltInToolName, any>>();
  const definitions = (cwd: string): Record<BuiltInToolName, any> => {
    let value = cache.get(cwd);
    if (!value) {
      value = Object.fromEntries(TOOL_NAMES.map((name) => [name, factories[name](cwd)])) as Record<BuiltInToolName, any>;
      cache.set(cwd, value);
    }
    return value;
  };

  for (const name of TOOL_NAMES) {
    const original = definitions(process.cwd())[name];
    pi.registerTool({
      ...original,
      renderShell: "self",
      async execute(toolCallId: string, params: unknown, signal: AbortSignal | undefined, onUpdate: ((result: unknown) => void) | undefined, ctx: ExtensionContext) {
        activity.start(toolCallId, name);
        const update = (result: unknown) => {
          activity.update(toolCallId, name, result);
          onUpdate?.(result);
        };
        try {
          return await definitions(ctx.cwd)[name].execute(toolCallId, params, signal, update, ctx);
        } finally {
          activity.end(toolCallId, ctx.mode !== "tui");
        }
      },
      renderCall(args: Record<string, unknown>, theme: Theme, context: any) {
        const state = context.state as {
          originalState?: Record<string, unknown>;
          originalCall?: Component;
          startedAt?: number;
          timing?: ActivityRecord;
        };
        if (context.expanded) {
          state.originalState ??= {};
          const component = definitions(context.cwd)[name].renderCall?.(args, theme, {
            ...context,
            state: state.originalState,
            lastComponent: state.originalCall,
          }) ?? emptyComponent();
          state.originalCall = component;
          return component;
        }
        const existing = activity.get(context.toolCallId);
        if (context.executionStarted && !context.isPartial && (state.timing || existing?.endedAt !== undefined)) {
          return emptyComponent();
        }
        const record = context.executionStarted
          ? activity.attach(context.toolCallId, name, context.invalidate)
          : undefined;
        const startedAt = state.startedAt ?? record?.startedAt ?? Date.now();
        state.startedAt = startedAt;
        return new SingleLine(() => {
          const status = context.executionStarted
            ? theme.fg("accent", sharedAnimationClock.frame)
            : theme.fg("dim", "·");
          const icon = theme.fg("accent", TOOL_ICONS[name]);
          const title = theme.fg("toolTitle", theme.bold(name));
          const subject = theme.fg("toolOutput", toolSubject(name, args));
          const duration = context.executionStarted ? theme.fg("dim", elapsed(startedAt)) : "";
          const progress = record?.progress ? theme.fg("muted", ` · ${record.progress}`) : "";
          return `${status} ${icon} ${title} ${subject}${duration ? ` · ${duration}` : ""}${progress}`;
        });
      },
      renderResult(result: ToolResultLike, options: { expanded: boolean; isPartial: boolean }, theme: Theme, context: any) {
        const state = context.state as {
          originalState?: Record<string, any>;
          originalResult?: Component;
          startedAt?: number;
          timing?: ActivityRecord;
        };
        state.originalState ??= {};
        if (options.expanded) {
          const component = definitions(context.cwd)[name].renderResult?.(result, options, theme, {
            ...context,
            state: state.originalState,
            lastComponent: state.originalResult,
          }) ?? emptyComponent();
          state.originalResult = component;
          if (!options.isPartial) {
            const timing = activity.finish(context.toolCallId);
            if (!state.timing && timing) state.timing = timing;
          }
          return component;
        }
        if (options.isPartial) return emptyComponent();
        if (state.originalState.interval) {
          clearInterval(state.originalState.interval);
          state.originalState.interval = undefined;
        }
        const currentTiming = activity.finish(context.toolCallId);
        const record = state.timing ?? currentTiming;
        if (record) state.timing = record;
        const summary = toolSummary(name, context.args, result, context.isError);
        const style = toneStyle(summary.tone);
        return new SingleLine(() => {
          const status = theme.fg(style.color, style.glyph);
          const icon = theme.fg("accent", TOOL_ICONS[name]);
          const title = theme.fg("toolTitle", theme.bold(name));
          const subject = theme.fg("toolOutput", toolSubject(name, context.args));
          const detail = theme.fg(style.color, summary.text);
          const start = record?.startedAt ?? state.startedAt;
          const duration = start ? theme.fg("dim", elapsed(start, record?.endedAt)) : "";
          return `${status} ${icon} ${title} ${subject} · ${detail}${duration ? ` · ${duration}` : ""}`;
        });
      },
    } as any);
  }

  return { clear: () => cache.clear() };
}
