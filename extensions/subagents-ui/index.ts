import upstreamSubagents from "@narumitw/pi-subagents/dist/index.ts";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Container, type Component, Text, truncateToWidth } from "@earendil-works/pi-tui";
import {
  partialProgress,
  sharedAnimationClock,
} from "@trevarj/trev-pi/tools.ts";
import { resultText, subagentCallSubject, summarizeSubagentResult } from "./render.ts";

const toolNames = new Set([
  "subagent_spawn",
  "subagent_inspect",
  "subagent_cancel",
  "subagent_wait",
  "subagent_send",
]);

interface LiveRecord {
  startedAt: number;
  endedAt?: number;
  progress?: string;
  invalidate?: () => void;
}

const records = new Map<string, LiveRecord>();

function title(name: string): string {
  return name.replace("subagent_", "subagent ");
}

function elapsed(start: number, end = Date.now()): string {
  const milliseconds = Math.max(0, end - start);
  return milliseconds < 1_000 ? `${milliseconds}ms` : `${(milliseconds / 1_000).toFixed(milliseconds < 10_000 ? 1 : 0)}s`;
}

class SingleLine implements Component {
  constructor(private readonly line: string | (() => string)) {}

  render(width: number): string[] {
    const line = typeof this.line === "function" ? this.line() : this.line;
    return width > 0 ? [truncateToWidth(line, width, "…")] : [];
  }

  invalidate(): void {}
}

function decorateTool(tool: any): any {
  if (!toolNames.has(tool.name)) return tool;
  return {
    ...tool,
    renderShell: "self",
    async execute(toolCallId: string, params: unknown, signal: AbortSignal | undefined, onUpdate: ((result: unknown) => void) | undefined, ctx: ExtensionContext) {
      const record = records.get(toolCallId) ?? { startedAt: Date.now() };
      records.set(toolCallId, record);
      sharedAnimationClock.start(`subagent:${toolCallId}`, () => record.invalidate?.());
      const update = (result: unknown) => {
        record.progress = partialProgress(result);
        onUpdate?.(result);
      };
      try {
        return await tool.execute(toolCallId, params, signal, update, ctx);
      } finally {
        record.endedAt = Date.now();
        sharedAnimationClock.stop(`subagent:${toolCallId}`);
        if (ctx.mode !== "tui") records.delete(toolCallId);
      }
    },
    renderCall(args: unknown, theme: Theme, context: any) {
      const state = context.state as {
        nativeState?: Record<string, unknown>;
        nativeCall?: Component;
        startedAt?: number;
        timing?: LiveRecord;
      };
      if (context.expanded && tool.renderCall) {
        state.nativeState ??= {};
        const component = tool.renderCall(args, theme, {
          ...context,
          state: state.nativeState,
          lastComponent: state.nativeCall,
        });
        state.nativeCall = component;
        return component;
      }
      const existing = records.get(context.toolCallId);
      if (context.executionStarted && !context.isPartial && (state.timing || existing?.endedAt !== undefined)) {
        return new Container();
      }
      const record = existing ?? { startedAt: Date.now() };
      records.set(context.toolCallId, record);
      record.invalidate = context.invalidate;
      const startedAt = state.startedAt ?? record.startedAt;
      state.startedAt = startedAt;
      if (context.executionStarted) sharedAnimationClock.start(`subagent:${context.toolCallId}`, () => record.invalidate?.());
      const subject = subagentCallSubject(tool.name, args);
      return new SingleLine(() => {
        const status = context.executionStarted
          ? theme.fg("accent", sharedAnimationClock.frame)
          : theme.fg("dim", "·");
        return `${status} ${theme.fg("accent", "󰚩")} ${theme.fg("toolTitle", theme.bold(title(tool.name)))} ${theme.fg("muted", subject || "job")}`
          + (context.executionStarted ? theme.fg("dim", ` · ${elapsed(startedAt)}`) : "")
          + (record.progress ? theme.fg("muted", ` · ${record.progress}`) : "");
      });
    },
    renderResult(result: any, options: { expanded: boolean; isPartial: boolean }, theme: Theme, context: any) {
      const state = context.state as {
        nativeState?: Record<string, unknown>;
        nativeResult?: Component;
        startedAt?: number;
        timing?: LiveRecord;
      };
      if (options.expanded) {
        const component = tool.renderResult
          ? tool.renderResult(result, options, theme, {
              ...context,
              state: state.nativeState ??= {},
              lastComponent: state.nativeResult,
            })
          : new Text(resultText(result.content), 0, 0);
        state.nativeResult = component;
        if (!options.isPartial) {
          const timing = records.get(context.toolCallId);
          if (!state.timing && timing) state.timing = timing;
          sharedAnimationClock.stop(`subagent:${context.toolCallId}`);
          records.delete(context.toolCallId);
        }
        return component;
      }
      if (options.isPartial) return new Container();
      const record = state.timing ?? records.get(context.toolCallId);
      if (record) state.timing = record;
      sharedAnimationClock.stop(`subagent:${context.toolCallId}`);
      records.delete(context.toolCallId);
      const summary = summarizeSubagentResult(tool.name, result.details, context.args, context.isError);
      const color = summary.tone === "error" ? "error" : summary.tone === "warning" ? "warning" : summary.tone === "neutral" ? "dim" : "success";
      const glyph = summary.tone === "error" ? "✗" : summary.tone === "warning" ? "!" : summary.tone === "neutral" ? "○" : "✓";
      const duration = elapsed(record?.startedAt ?? state.startedAt ?? Date.now(), record?.endedAt);
      return new SingleLine(() =>
        `${theme.fg(color, glyph)} ${theme.fg("accent", "󰚩")} ${theme.fg("toolTitle", theme.bold(title(tool.name)))} ${theme.fg(color, summary.text)} ${theme.fg("dim", `· ${duration}`)}`,
      );
    },
  };
}

export default function subagentsUi(pi: ExtensionAPI): void {
  const adaptedPi = new Proxy(pi, {
    get(target, property, receiver) {
      if (property === "registerTool") return (tool: any) => target.registerTool(decorateTool(tool));
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  upstreamSubagents(adaptedPi);
  pi.on("session_shutdown", () => {
    for (const id of records.keys()) sharedAnimationClock.stop(`subagent:${id}`);
    records.clear();
  });
}
