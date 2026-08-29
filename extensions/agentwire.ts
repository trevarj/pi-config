// Agentwire bridge: serve this pi session over a local JSONL socket so the
// Agentwire IRC bridge can list, observe, and drive it. Frames mirror pi's
// RPC mode shapes so the bridge shares one translator for live TUI sessions
// (this socket) and bridge-spawned `pi --mode rpc` subprocesses.
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

// --- minimal structural types for the pi surfaces this extension touches ---

interface ModelInfo {
  provider: string;
  id: string;
  name?: string;
  reasoning?: boolean;
}

interface SessionEntry {
  id: string;
  parentId: string | null;
  type?: string;
  timestamp?: string | number;
  message?: Record<string, unknown>;
}

interface AgentwireContext {
  cwd: string;
  model?: ModelInfo | null;
  isIdle(): boolean;
  abort(): void;
  getContextUsage(): { tokens: number; contextWindow: number; percent: number } | undefined;
  sessionManager: {
    getSessionFile(): string | null;
    getSessionId?(): string | undefined;
    getBranch(): unknown[];
  };
}

interface AgentwireExtensionAPI {
  on(event: string, handler: (event: Record<string, unknown>, ctx: AgentwireContext) => unknown): void;
  // The cross-extension bus pi-subagents publishes lifecycle events on. Optional:
  // pi builds without a bus (and the test doubles) simply report no subagents.
  events?: { on(event: string, handler: (payload: unknown) => void): unknown };
  sendUserMessage(content: string, options?: { deliverAs?: "steer" | "followUp" }): void;
  setModel(model: ModelInfo): void;
  setThinkingLevel(level: string): void;
  getThinkingLevel(): string;
  setSessionName(name: string): void;
  getSessionName(): string | undefined;
}

// --- framing: strict LF-delimited JSONL, mirroring pi's RPC mode ---

const MAX_TEXT_BYTES = 32 * 1024;
const MAX_ENTRIES = 500;

export function encodeFrame(frame: Record<string, unknown>): string {
  return `${JSON.stringify(frame)}\n`;
}

/** Incremental LF splitter; tolerates trailing CR, never splits on U+2028/29. */
export function createLineDecoder(onLine: (line: string) => void): (chunk: string) => void {
  let buffer = "";
  return (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const index = buffer.indexOf("\n");
      if (index === -1) return;
      let line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line) onLine(line);
    }
  };
}

export function truncateText(value: string, limit = MAX_TEXT_BYTES): string {
  if (Buffer.byteLength(value, "utf8") <= limit) return value;
  const sliced = Buffer.from(value, "utf8").subarray(0, limit).toString("utf8");
  // Drop a possibly split trailing code point and mark the cut.
  return `${sliced.replace(/\uFFFD+$/u, "")}…[truncated]`;
}

// --- serialization: condense pi message/tool payloads into safe wire shapes ---

function blockText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts = content
    .map((item) => {
      if (!item || typeof item !== "object") return "";
      const block = item as { type?: string; text?: string };
      if (block.type === "text") return String(block.text ?? "");
      if (block.type === "image") return "[image]";
      return "";
    })
    .filter((part) => part.trim());
  return parts.join("\n\n").trim();
}

export function serializeMessage(message: Record<string, unknown>): Record<string, unknown> | null {
  const role = message.role;
  const timestamp = typeof message.timestamp === "number" ? message.timestamp : undefined;
  if (role === "user") {
    const text = blockText(message.content);
    return text ? { role, text: truncateText(text), timestamp } : null;
  }
  if (role === "assistant") {
    const content = Array.isArray(message.content) ? message.content : [];
    const toolCalls = content
      .filter((item): item is { id?: unknown; name?: unknown; arguments?: unknown } => {
        return !!item && typeof item === "object" && (item as { type?: string }).type === "toolCall";
      })
      .map((item) => ({
        id: String(item.id ?? ""),
        name: String(item.name ?? "tool"),
        arguments: pruneArgs(item.arguments),
      }));
    const text = blockText(content);
    if (!text && !toolCalls.length) return null;
    return {
      role,
      text: truncateText(text),
      toolCalls,
      stopReason: typeof message.stopReason === "string" ? message.stopReason : undefined,
      errorMessage:
        typeof message.errorMessage === "string" ? truncateText(message.errorMessage, 2048) : undefined,
      timestamp,
    };
  }
  if (role === "toolResult") {
    return {
      role,
      toolCallId: String(message.toolCallId ?? ""),
      toolName: String(message.toolName ?? "tool"),
      text: truncateText(blockText(message.content)),
      isError: !!message.isError,
      timestamp,
    };
  }
  return null;
}

/** Bound tool arguments: keep short scalar fields, elide bulk (file bodies, images). */
export function pruneArgs(args: unknown): Record<string, unknown> {
  if (!args || typeof args !== "object" || Array.isArray(args)) return {};
  const pruned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    if (typeof value === "string") pruned[key] = truncateText(value, 2048);
    else if (typeof value === "number" || typeof value === "boolean") pruned[key] = value;
    // Arrays and objects (edit lists, image payloads) stay off the wire.
  }
  return pruned;
}

export function serializeEntries(
  branch: unknown[],
  since?: string,
  limit = MAX_ENTRIES,
): { entries: Record<string, unknown>[]; leafId: string | null } {
  const messages = (branch as SessionEntry[]).filter(
    (entry) => entry && entry.type === "message" && entry.message,
  );
  let start = 0;
  if (since) {
    const index = messages.findIndex((entry) => entry.id === since);
    if (index === -1) throw new Error(`unknown entry cursor: ${since}`);
    start = index + 1;
  }
  const window = messages.slice(start, start + limit);
  const entries: Record<string, unknown>[] = [];
  for (const entry of window) {
    const message = serializeMessage(entry.message as Record<string, unknown>);
    if (!message) continue;
    entries.push({ id: entry.id, timestamp: entry.timestamp, message });
  }
  return { entries, leafId: messages.at(-1)?.id ?? null };
}

// --- subagent registry: pi-subagents lifecycle, condensed for the wire ---

const SUBAGENT_DESCRIPTION_BYTES = 200;
const SUBAGENT_TERMINAL_CAP = 10;
const SUBAGENT_TERMINAL_MS = 5 * 60 * 1000;

export type SubagentStatus = "queued" | "running" | "completed" | "failed";

export interface SubagentEntry {
  id: string;
  type: string;
  description: string;
  status: SubagentStatus;
  isBackground: boolean;
  toolUses?: number;
  durationMs?: number;
  tokens?: number;
}

/** pi-subagents event names this registry tracks, mapped to the status each sets. */
export const SUBAGENT_EVENTS: Record<string, SubagentStatus> = {
  "subagents:created": "queued",
  "subagents:started": "running",
  "subagents:completed": "completed",
  "subagents:failed": "failed",
};

export interface SubagentRegistry {
  /** Returns true when the event changed the list, i.e. a broadcast is owed. */
  apply(event: string, payload: unknown): boolean;
  list(): SubagentEntry[];
}

/** Keep a number only when the payload actually carried one (`tokens` may be an object). */
function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Live view of this session's top-level subagents. Non-terminal agents are kept
 * indefinitely; finished ones are bounded twice over (a recency cap and an age
 * cutoff) so a long session cannot grow the frame without limit. `now` is
 * injected so expiry is testable without waiting.
 */
export function createSubagentRegistry(now: () => number = Date.now): SubagentRegistry {
  // Insertion-ordered. Settling re-inserts, so the terminal entries appear in
  // settle order and the cap below can drop from the front.
  const agents = new Map<string, SubagentEntry & { settledAt?: number }>();

  const prune = () => {
    const cutoff = now() - SUBAGENT_TERMINAL_MS;
    const settled: string[] = [];
    for (const agent of agents.values()) {
      if (agent.settledAt === undefined) continue;
      if (agent.settledAt <= cutoff) agents.delete(agent.id);
      else settled.push(agent.id);
    }
    for (const id of settled.slice(0, Math.max(0, settled.length - SUBAGENT_TERMINAL_CAP))) {
      agents.delete(id);
    }
  };

  return {
    apply(event, payload) {
      const status = SUBAGENT_EVENTS[event];
      if (!status || !payload || typeof payload !== "object" || Array.isArray(payload)) return false;
      const raw = payload as Record<string, unknown>;
      const id = String(raw.id ?? "");
      if (!id) return false;
      // Scheduler and RPC spawns can surface as `started` without a prior
      // `created`, so every tracked event may open the entry.
      const previous = agents.get(id);
      const entry: SubagentEntry & { settledAt?: number } = {
        id,
        type: String(raw.type ?? previous?.type ?? "agent"),
        description: truncateText(
          String(raw.description ?? previous?.description ?? ""),
          SUBAGENT_DESCRIPTION_BYTES,
        ),
        status,
        isBackground:
          typeof raw.isBackground === "boolean" ? raw.isBackground : (previous?.isBackground ?? false),
      };
      if (status === "completed" || status === "failed") {
        entry.settledAt = now();
        const toolUses = finiteNumber(raw.toolUses);
        const durationMs = finiteNumber(raw.durationMs);
        const tokens = finiteNumber(raw.tokens);
        if (toolUses !== undefined) entry.toolUses = toolUses;
        if (durationMs !== undefined) entry.durationMs = durationMs;
        if (tokens !== undefined) entry.tokens = tokens;
        agents.delete(id);
      }
      agents.set(id, entry);
      prune();
      return true;
    },
    list() {
      prune();
      return [...agents.values()].map(({ settledAt: _settledAt, ...entry }) => entry);
    },
  };
}

// --- command dispatch: RPC-compatible surface over the socket ---

export interface CommandPorts {
  state(): Record<string, unknown>;
  isIdle(): boolean;
  sendUserMessage(text: string, deliverAs?: "steer" | "followUp"): void;
  abort(): void;
  entries(since?: string, limit?: number): { entries: Record<string, unknown>[]; leafId: string | null };
  availableModels(): ModelInfo[];
  setModel(provider: string, modelId: string): void;
  setThinkingLevel(level: string): void;
  setSessionName(name: string): void;
  stats(): Record<string, unknown>;
}

export function handleCommand(
  command: Record<string, unknown>,
  ports: CommandPorts,
): Record<string, unknown> {
  const id = command.id;
  const type = String(command.type ?? "");
  const respond = (success: boolean, extra: Record<string, unknown> = {}) => ({
    ...(id === undefined ? {} : { id }),
    type: "response",
    command: type,
    success,
    ...extra,
  });
  try {
    switch (type) {
      case "prompt": {
        const message = String(command.message ?? "");
        if (!message.trim()) return respond(false, { error: "empty prompt" });
        ports.sendUserMessage(message, ports.isIdle() ? undefined : "steer");
        return respond(true);
      }
      case "steer": {
        const message = String(command.message ?? "");
        if (!message.trim()) return respond(false, { error: "empty steer message" });
        if (ports.isIdle()) return respond(false, { error: "no active turn to steer" });
        ports.sendUserMessage(message, "steer");
        return respond(true);
      }
      case "follow_up": {
        const message = String(command.message ?? "");
        if (!message.trim()) return respond(false, { error: "empty follow-up message" });
        ports.sendUserMessage(message, ports.isIdle() ? undefined : "followUp");
        return respond(true);
      }
      case "abort":
        ports.abort();
        return respond(true);
      case "get_state":
        return respond(true, { data: ports.state() });
      case "get_entries": {
        const since = command.since === undefined ? undefined : String(command.since);
        const limit = typeof command.limit === "number" ? command.limit : undefined;
        return respond(true, { data: ports.entries(since, limit) });
      }
      case "get_available_models":
        return respond(true, {
          data: {
            models: ports.availableModels().map((model) => ({
              provider: model.provider,
              id: model.id,
              name: model.name ?? model.id,
              reasoning: !!model.reasoning,
            })),
          },
        });
      case "set_model":
        ports.setModel(String(command.provider ?? ""), String(command.modelId ?? ""));
        return respond(true);
      case "set_thinking_level":
        ports.setThinkingLevel(String(command.level ?? ""));
        return respond(true);
      case "set_session_name":
        ports.setSessionName(String(command.name ?? ""));
        return respond(true);
      case "get_session_stats":
        return respond(true, { data: ports.stats() });
      default:
        return respond(false, { error: `unknown command: ${type || "(missing type)"}` });
    }
  } catch (error) {
    return respond(false, { error: error instanceof Error ? error.message : String(error) });
  }
}

// --- socket path ---

export function socketDir(env: NodeJS.ProcessEnv = process.env): string {
  const runtime = env.XDG_RUNTIME_DIR;
  return join(runtime && runtime.startsWith("/") ? runtime : tmpdir(), "agentwire", "pi");
}

export function socketPath(pid = process.pid): string {
  return join(socketDir(), `${pid}-${randomUUID()}.sock`);
}

// --- extension runtime ---

export default function agentwire(pi: AgentwireExtensionAPI) {
  // Bridge-owned `pi --mode rpc` subprocesses are driven over stdio by the
  // bridge itself; a second registration here would list them twice.
  if (process.env.AGENTWIRE_SPAWNED === "1") return;

  let lastCtx: AgentwireContext | undefined;
  let busy = false;
  let modelRegistry: { getAvailable(): ModelInfo[] } | undefined;
  const subagents = createSubagentRegistry();
  const clients = new Set<Socket>();
  const path = socketPath();
  let server: Server | undefined;

  const state = (): Record<string, unknown> => {
    const sessionFile = lastCtx?.sessionManager.getSessionFile() ?? null;
    const model = lastCtx?.model ?? null;
    return {
      sessionId:
        lastCtx?.sessionManager.getSessionId?.() ??
        (sessionFile ? sessionFile.replace(/^.*\//, "").replace(/\.jsonl$/, "") : null),
      sessionFile,
      cwd: lastCtx?.cwd ?? process.cwd(),
      sessionName: pi.getSessionName() ?? null,
      model: model ? { provider: model.provider, id: model.id, name: model.name ?? model.id } : null,
      thinkingLevel: pi.getThinkingLevel(),
      busy,
      pid: process.pid,
      // Carried by `hello` and `session_changed` so a late client does not have
      // to wait for the next lifecycle event to learn about running agents.
      subagents: subagents.list(),
    };
  };

  const broadcast = (frame: Record<string, unknown>) => {
    const line = encodeFrame(frame);
    for (const socket of clients) socket.write(line);
  };

  const ports: CommandPorts = {
    state,
    isIdle: () => (lastCtx ? lastCtx.isIdle() : !busy),
    sendUserMessage: (text, deliverAs) =>
      pi.sendUserMessage(text, deliverAs ? { deliverAs } : undefined),
    abort: () => lastCtx?.abort(),
    entries: (since, limit) =>
      serializeEntries(lastCtx?.sessionManager.getBranch() ?? [], since, limit),
    availableModels: () => modelRegistry?.getAvailable() ?? [],
    setModel: (provider, modelId) => {
      const model = (modelRegistry?.getAvailable() ?? []).find(
        (candidate) => candidate.provider === provider && candidate.id === modelId,
      );
      if (!model) throw new Error(`model not found: ${provider}/${modelId}`);
      pi.setModel(model);
    },
    setThinkingLevel: (level) => pi.setThinkingLevel(level),
    setSessionName: (name) => pi.setSessionName(name),
    stats: () => ({ contextUsage: lastCtx?.getContextUsage() ?? null }),
  };

  const listen = () => {
    if (server) return;
    mkdirSync(socketDir(), { recursive: true, mode: 0o700 });
    rmSync(path, { force: true });
    server = createServer((socket) => {
      clients.add(socket);
      socket.setEncoding("utf8");
      socket.write(encodeFrame({ type: "hello", pv: 1, ...state() }));
      const decode = createLineDecoder((line) => {
        let command: Record<string, unknown>;
        try {
          const parsed: unknown = JSON.parse(line);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
          command = parsed as Record<string, unknown>;
        } catch {
          socket.write(
            encodeFrame({ type: "response", command: "parse", success: false, error: "invalid JSON command" }),
          );
          return;
        }
        socket.write(encodeFrame(handleCommand(command, ports)));
      });
      socket.on("data", decode);
      const drop = () => clients.delete(socket);
      socket.on("close", drop);
      socket.on("error", drop);
    });
    server.on("error", () => shutdown());
    server.listen(path);
  };

  const shutdown = () => {
    for (const socket of clients) socket.destroy();
    clients.clear();
    server?.close();
    server = undefined;
    rmSync(path, { force: true });
  };

  pi.on("session_start", (_event, ctx) => {
    lastCtx = ctx;
    modelRegistry = (ctx as unknown as { modelRegistry?: { getAvailable(): ModelInfo[] } })
      .modelRegistry;
    busy = false;
    listen();
    broadcast({ type: "session_changed", ...state() });
  });
  pi.on("session_info_changed", (_event, ctx) => {
    lastCtx = ctx;
    broadcast({ type: "session_changed", ...state() });
  });
  pi.on("model_select", (_event, ctx) => {
    lastCtx = ctx;
    broadcast({ type: "session_changed", ...state() });
  });
  pi.on("thinking_level_select", (_event, ctx) => {
    lastCtx = ctx;
    broadcast({ type: "session_changed", ...state() });
  });
  pi.on("agent_start", (_event, ctx) => {
    lastCtx = ctx;
    busy = true;
    broadcast({ type: "agent_start" });
  });
  pi.on("agent_settled", (_event, ctx) => {
    lastCtx = ctx;
    busy = false;
    broadcast({ type: "agent_settled" });
  });
  pi.on("message_end", (event, ctx) => {
    lastCtx = ctx;
    const raw = event.message;
    if (!raw || typeof raw !== "object") return;
    const role = (raw as { role?: unknown }).role;
    // Tool results ride the tool_execution_end frames instead.
    if (role !== "user" && role !== "assistant") return;
    const message = serializeMessage(raw as Record<string, unknown>);
    if (message) broadcast({ type: "message_end", message });
  });
  pi.on("tool_execution_start", (event, ctx) => {
    lastCtx = ctx;
    broadcast({
      type: "tool_execution_start",
      toolCallId: String(event.toolCallId ?? ""),
      toolName: String(event.toolName ?? "tool"),
      args: pruneArgs(event.args),
    });
  });
  pi.on("tool_execution_end", (event, ctx) => {
    lastCtx = ctx;
    const result = event.result as { content?: unknown } | undefined;
    broadcast({
      type: "tool_execution_end",
      toolCallId: String(event.toolCallId ?? ""),
      toolName: String(event.toolName ?? "tool"),
      isError: !!event.isError,
      output: truncateText(blockText(result?.content)),
    });
  });
  // pi-subagents publishes top-level agent lifecycle on the shared bus; mirror it
  // so clients can render the same list the TUI widget shows.
  for (const event of Object.keys(SUBAGENT_EVENTS)) {
    pi.events?.on(event, (payload) => {
      if (subagents.apply(event, payload)) {
        broadcast({ type: "subagent_update", agents: subagents.list() });
      }
    });
  }
  pi.on("session_shutdown", () => {
    shutdown();
    lastCtx = undefined;
  });
}
