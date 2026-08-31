import upstreamSubagents from "@narumitw/pi-subagents/dist/index.ts";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { resultText, subagentCallSubject, summarizeSubagentResult } from "./render.ts";

const toolNames = new Set([
  "subagent_spawn",
  "subagent_inspect",
  "subagent_cancel",
  "subagent_wait",
  "subagent_send",
]);

function title(name: string): string {
  return name.replace("subagent_", "subagent ");
}

function decorateTool(tool: any): any {
  if (!toolNames.has(tool.name)) return tool;
  return {
    ...tool,
    renderShell: "self",
    renderCall(args: unknown, theme: Theme, context: any) {
      if (!context.expanded && !context.isPartial && context.executionStarted) return new Container();
      const subject = subagentCallSubject(tool.name, args);
      const line = theme.fg("toolTitle", theme.bold(title(tool.name)))
        + (subject ? `  ${theme.fg("muted", subject)}` : "");
      return new Text(line, 0, 0);
    },
    renderResult(result: any, options: { expanded: boolean; isPartial: boolean }, theme: Theme, context: any) {
      if (options.isPartial) return new Container();
      if (options.expanded) return new Text(resultText(result.content), 0, 0);
      const summary = summarizeSubagentResult(tool.name, result.details, context.args, context.isError);
      const color = summary.tone === "error" ? "error" : summary.tone === "warning" ? "warning" : "success";
      const glyph = summary.tone === "error" ? "✗" : summary.tone === "warning" ? "↻" : "✓";
      return new Text(
        `${theme.fg(color, glyph)} ${theme.fg("toolTitle", theme.bold(title(tool.name)))}  ${theme.fg(color === "success" ? "dim" : color, summary.text)}`,
        0,
        0,
      );
    },
  };
}

export default function subagentsUi(pi: ExtensionAPI): void {
  const adaptedPi = new Proxy(pi, {
    get(target, property, receiver) {
      if (property === "registerTool") {
        return (tool: any) => target.registerTool(decorateTool(tool));
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  upstreamSubagents(adaptedPi);
}
