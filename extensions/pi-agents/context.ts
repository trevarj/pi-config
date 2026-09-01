const DEFAULT_CONTEXT_BYTES = 24 * 1024;
const FULL_CONTEXT_BYTES = 96 * 1024;

const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gi,
  /\b(?:sk|xox[baprs]|gh[opusr])-[A-Za-z0-9_-]{12,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+\/-]{12,}\b/gi,
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\s*[:=]\s*[^\s,;]+/gi,
];

export function redactSecrets(text: string): string {
  let redacted = text.replaceAll("\0", "");
  for (const pattern of SECRET_PATTERNS) redacted = redacted.replace(pattern, "[redacted]");
  return redacted;
}

function textBlocks(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: string; text?: string } => !!block && typeof block === "object")
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .filter(Boolean)
    .join("\n\n");
}

export interface SafeContextEntry {
  role: "user" | "assistant";
  text: string;
}

export function safeConversation(branch: readonly unknown[]): { summary?: string; messages: SafeContextEntry[] } {
  let summary: string | undefined;
  const messages: SafeContextEntry[] = [];
  for (const raw of branch) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    if (entry.type === "compaction") {
      const candidate = typeof entry.summary === "string"
        ? entry.summary
        : typeof (entry.compaction as { summary?: unknown } | undefined)?.summary === "string"
          ? String((entry.compaction as { summary: string }).summary)
          : undefined;
      if (candidate) summary = redactSecrets(candidate);
      continue;
    }
    if (entry.type !== "message" || !entry.message || typeof entry.message !== "object") continue;
    const message = entry.message as Record<string, unknown>;
    if (message.role !== "user" && message.role !== "assistant") continue;
    const text = redactSecrets(textBlocks(message.content)).trim();
    if (text) messages.push({ role: message.role, text });
  }
  return { summary, messages };
}

export function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const buffer = Buffer.from(value, "utf8").subarray(0, Math.max(0, maxBytes - 18));
  return `${buffer.toString("utf8").replace(/\uFFFD+$/u, "")}\n[context truncated]`;
}

export function buildDelegatedContext(options: {
  task: string;
  branch: readonly unknown[];
  gitSummary: string;
  mode?: "bounded" | "fresh" | "full";
  maxBytes?: number;
}): string {
  const mode = options.mode ?? "bounded";
  const limit = options.maxBytes ?? (mode === "full" ? FULL_CONTEXT_BYTES : DEFAULT_CONTEXT_BYTES);
  const safe = safeConversation(options.branch);
  const task = redactSecrets(options.task).trim();
  const git = redactSecrets(options.gitSummary).trim();
  const fixed = [`# Delegated task\n${task}`, git ? `# Git summary\n${git}` : ""].filter(Boolean);
  if (mode !== "fresh" && safe.summary) fixed.push(`# Latest compaction summary\n${safe.summary}`);
  let output = fixed.join("\n\n");
  if (mode !== "fresh") {
    const recent: string[] = [];
    for (let index = safe.messages.length - 1; index >= 0; index--) {
      const message = safe.messages[index];
      const candidate = `## ${message.role}\n${message.text}`;
      const assembled = [...fixed, `# Recent conversation\n${[candidate, ...recent].join("\n\n")}`].join("\n\n");
      if (Buffer.byteLength(assembled, "utf8") > limit) break;
      recent.unshift(candidate);
      output = assembled;
    }
  }
  return truncateUtf8(output, limit);
}
