import { homedir } from "node:os";

export type BuiltInToolName = "bash" | "read" | "edit" | "write" | "grep" | "find" | "ls";

export interface ResultBlock {
  type: string;
  text?: string;
}

export interface ToolResultLike {
  content: ResultBlock[];
  details?: unknown;
}

export interface FooterPart {
  id: "project" | "branch" | "model" | "queue" | "context";
  text: string;
  priority: number;
}

const ANSI_PATTERN = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

export function oneLine(value: unknown): string {
  return String(value ?? "").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
}

// Important statuses render first; decorative mode markers go last so the
// tail truncation eats them before anything actionable (the goal status was
// invisible for months because "workflow:goal" sorts alphabetically last).
const STATUS_RANKS: Record<string, number> = {
  "workflow:goal": 0,
  "work-mode": 1,
  caveman: 8,
  ponytail: 8,
  "pi-lens-lsp": 9,
};

export function statusRank(name: string): number {
  return STATUS_RANKS[name] ?? 5;
}

export function compactPluginStatus(name: string, status: string): string {
  const plain = oneLine(stripAnsi(status));
  if (name === "pi-lens-lsp" && /^LSP (?:Active|Inactive)(?::.*)?$/i.test(plain)) return "󰒋";
  if (name === "workflow:goal") {
    // pi-workflow formats: "active 12m · automatic 3/25", "paused · automatic
    // 3/25", "waiting <reason> · automatic 3/25", "complete". Keep the state
    // word (except the implied "active") and the turn counter.
    if (/^complete\b/i.test(plain)) return "󰓾 ✓";
    const counter = plain.match(/automatic (\d+\/\d+|Unlimited)/i)?.[1];
    const state = plain.match(/^(active|queued|waiting|paused|blocked|usage|budget)/i)?.[1];
    if (!counter && !state) return plain;
    const label = state && state.toLowerCase() !== "active" ? ` ${state.toLowerCase()}` : "";
    return `󰓾${label}${counter ? ` ${counter}` : ""}`;
  }
  const level = name === "caveman"
    ? plain.match(/caveman level:\s*(\S+)/i)?.[1]?.toLowerCase()
    : name === "ponytail"
      ? plain.match(/\b(lite|full|ultra)\b/i)?.[1]?.toLowerCase()
      : undefined;
  if (!level) return plain;
  const count = ({ lite: 1, full: 2, ultra: 3 } as Record<string, number>)[level];
  return count ? `${name} ${"▰".repeat(count)}` : `${name} ${level}`;
}

export function shortenPath(path: string, home = homedir()): string {
  if (!path) return ".";
  if (path === home) return "~";
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

export function compactNumber(value: number): string {
  if (value < 1_000) return String(value);
  if (value < 10_000) return `${(value / 1_000).toFixed(1)}k`;
  if (value < 1_000_000) return `${Math.round(value / 1_000)}k`;
  if (value < 10_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  return `${Math.round(value / 1_000_000)}M`;
}

function textOutput(result: ToolResultLike): string {
  return result.content.filter((block) => block.type === "text").map((block) => block.text ?? "").join("\n");
}

function countLines(text: string): number {
  const trimmed = text.replace(/\s+$/, "");
  return trimmed ? trimmed.split("\n").length : 0;
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function diffStats(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) added++;
    if (line.startsWith("-") && !line.startsWith("---")) removed++;
  }
  return { added, removed };
}

export function toolSubject(name: BuiltInToolName, args: Record<string, unknown>): string {
  const path = shortenPath(String(args.path ?? args.file_path ?? "."));
  switch (name) {
    case "bash":
      return oneLine(args.command) || "…";
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
      const root = shortenPath(String(args.path ?? "."));
      const glob = oneLine(args.glob);
      return `/${pattern}/ in ${root}${glob ? ` · ${glob}` : ""}`;
    }
    case "find":
      return `${oneLine(args.pattern)} in ${shortenPath(String(args.path ?? "."))}`;
  }
}

export function toolSummary(
  name: BuiltInToolName,
  args: Record<string, unknown>,
  result: ToolResultLike,
  isError: boolean,
): { text: string; negative: boolean } {
  const output = textOutput(result);
  if (isError) return { text: oneLine(output.split("\n", 1)[0]) || "failed", negative: true };

  if (name === "grep" && /^No matches found\s*$/i.test(output)) {
    return { text: "no matches", negative: true };
  }

  switch (name) {
    case "read":
      if (result.content.some((block) => block.type === "image")) return { text: "image", negative: false };
      return { text: plural(countLines(output), "line"), negative: false };
    case "grep":
      return { text: plural(countLines(output), "result"), negative: false };
    case "find":
      return {
        text: /^No files found matching pattern\s*$/i.test(output) ? "0 files" : plural(countLines(output), "file"),
        negative: false,
      };
    case "ls":
      return {
        text: /^\(empty directory\)\s*$/i.test(output) ? "0 entries" : plural(countLines(output), "entry", "entries"),
        negative: false,
      };
    case "bash": {
      const lines = countLines(output);
      return { text: lines ? plural(lines, "line") : "done", negative: false };
    }
    case "edit": {
      const details = result.details as { diff?: unknown } | undefined;
      const stats = diffStats(typeof details?.diff === "string" ? details.diff : "");
      return { text: `+${stats.added} −${stats.removed}`, negative: false };
    }
    case "write": {
      const content = typeof args.content === "string" ? args.content : "";
      return { text: plural(countLines(content), "line"), negative: false };
    }
  }
}

export function fitFooterParts(
  parts: FooterPart[],
  width: number,
  measure: (text: string) => number = (text) => stripAnsi(text).length,
): FooterPart[] {
  const kept = [...parts];
  const totalWidth = () => kept.reduce((sum, item, index) => sum + measure(item.text) + (index ? 2 : 0), 0);

  while (kept.length > 1 && totalWidth() > width) {
    const removable = kept.reduce((lowest, part) => part.priority < lowest.priority ? part : lowest);
    kept.splice(kept.indexOf(removable), 1);
  }

  return kept;
}

export function splitResourceCommands(commands: Array<{ name: string; source: string }>): {
  skills: string[];
  commands: string[];
  prompts: string[];
} {
  const uniqueSorted = (values: string[]) => [...new Set(values)].sort((a, b) => a.localeCompare(b));
  return {
    skills: uniqueSorted(commands.filter((command) => command.source === "skill").map((command) => command.name.replace(/^skill:/, ""))),
    commands: uniqueSorted(commands.filter((command) => command.source === "extension").map((command) => `/${command.name}`)),
    prompts: uniqueSorted(commands.filter((command) => command.source === "prompt").map((command) => `/${command.name}`)),
  };
}
