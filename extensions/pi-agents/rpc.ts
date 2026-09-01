import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { AgentKind, ModelRef } from "./types.ts";

const MAX_FRAME_BYTES = 1024 * 1024;
const RESPONSE_TIMEOUT_MS = 15_000;
const KILL_GRACE_MS = 3_000;

export class JsonlDecoder {
  private readonly decoder = new StringDecoder("utf8");
  private buffer = "";
  private readonly onFrame: (frame: Record<string, unknown>) => void;

  constructor(onFrame: (frame: Record<string, unknown>) => void) {
    this.onFrame = onFrame;
  }

  push(chunk: Buffer | string): void {
    this.buffer += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    if (Buffer.byteLength(this.buffer, "utf8") > MAX_FRAME_BYTES && !this.buffer.includes("\n")) {
      throw new Error("JSONL frame exceeded 1 MiB.");
    }
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      let line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line) continue;
      if (Buffer.byteLength(line, "utf8") > MAX_FRAME_BYTES) throw new Error("JSONL frame exceeded 1 MiB.");
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("JSONL frame must be an object.");
      this.onFrame(parsed as Record<string, unknown>);
    }
  }

  finish(): void {
    this.buffer += this.decoder.end();
    if (this.buffer.trim()) throw new Error("RPC stream ended with an unterminated JSONL frame.");
  }
}

export function encodeJsonl(frame: Record<string, unknown>): string {
  return `${JSON.stringify(frame)}\n`;
}

export interface RpcInvocation {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface RpcProcessOptions {
  invocation: RpcInvocation;
  onEvent?: (event: Record<string, unknown>) => void;
  onIpcRequest?: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  onClose?: (error?: Error) => void;
}

export class RpcProcess {
  private readonly options: RpcProcessOptions;
  private child?: ChildProcess;
  private sequence = 0;
  private pending = new Map<string, {
    resolve: (value: Record<string, unknown>) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  private closing = false;
  stderr = "";

  constructor(options: RpcProcessOptions) {
    this.options = options;
  }

  async start(): Promise<Record<string, unknown>> {
    if (this.child) throw new Error("RPC process already started.");
    const invocation = this.options.invocation;
    const child = spawn(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      env: invocation.env,
      detached: process.platform !== "win32",
      shell: false,
      stdio: ["pipe", "pipe", "pipe", "pipe"],
    });
    this.child = child;
    const stdout = new JsonlDecoder((frame) => this.handleRpcFrame(frame));
    const collaboration = new JsonlDecoder((frame) => void this.handleIpcFrame(frame));
    child.stdout?.on("data", (chunk) => {
      try { stdout.push(chunk); } catch (error) { this.fail(error); }
    });
    child.stderr?.on("data", (chunk) => {
      this.stderr = `${this.stderr}${String(chunk)}`.slice(-32 * 1024);
    });
    child.stdio[3]?.on("data", (chunk) => {
      try { collaboration.push(chunk as Buffer); } catch (error) { this.fail(error); }
    });
    child.once("error", (error) => this.fail(error));
    child.once("close", (code, signal) => {
      let framingError: Error | undefined;
      try { stdout.finish(); collaboration.finish(); } catch (error) {
        framingError = error instanceof Error ? error : new Error(String(error));
      }
      const unexpected = this.closing
        ? undefined
        : framingError ?? new Error(`RPC child exited (${code ?? signal ?? "unknown"}).`);
      this.rejectPending(unexpected ?? new Error("RPC child closed."));
      this.child = undefined;
      this.options.onClose?.(unexpected);
    });
    await new Promise<void>((resolveStart, rejectStart) => {
      child.once("spawn", resolveStart);
      child.once("error", rejectStart);
    });
    const response = await this.send({ type: "get_state" });
    return (response.data as Record<string, unknown> | undefined) ?? {};
  }

  send(command: Record<string, unknown>, timeoutMs = RESPONSE_TIMEOUT_MS): Promise<Record<string, unknown>> {
    const child = this.child;
    if (!child?.stdin?.writable) return Promise.reject(new Error("RPC child input is unavailable."));
    const id = `rpc-${++this.sequence}`;
    return new Promise((resolveResponse, rejectResponse) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectResponse(new Error(`RPC ${String(command.type)} response timed out.`));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, { resolve: resolveResponse, reject: rejectResponse, timer });
      child.stdin!.write(encodeJsonl({ id, ...command }), (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(error);
      });
    });
  }

  sendIpc(frame: Record<string, unknown>): void {
    const pipe = this.child?.stdio[3];
    if (!pipe || !("write" in pipe) || typeof pipe.write !== "function") throw new Error("Collaboration IPC is unavailable.");
    pipe.write(encodeJsonl(frame));
  }

  async prompt(message: string): Promise<void> {
    const response = await this.send({ type: "prompt", message });
    if (response.success !== true) throw new Error(String(response.error ?? "Child prompt was rejected."));
  }

  async steer(message: string): Promise<void> {
    const response = await this.send({ type: "steer", message });
    if (response.success !== true) throw new Error(String(response.error ?? "Child steer was rejected."));
  }

  async abort(): Promise<void> {
    try { await this.send({ type: "abort" }, 2_000); } catch { /* process teardown follows */ }
  }

  close(): void {
    if (this.closing) return;
    this.closing = true;
    const child = this.child;
    if (!child) return;
    const pid = child.pid;
    try {
      if (process.platform !== "win32" && pid) process.kill(-pid, "SIGTERM");
      else child.kill("SIGTERM");
    } catch { child.kill("SIGTERM"); }
    const timer = setTimeout(() => {
      if (!this.child || this.child.exitCode !== null) return;
      try {
        if (process.platform !== "win32" && pid) process.kill(-pid, "SIGKILL");
        else this.child.kill("SIGKILL");
      } catch { this.child.kill("SIGKILL"); }
    }, KILL_GRACE_MS);
    timer.unref();
  }

  private handleRpcFrame(frame: Record<string, unknown>): void {
    if (frame.type === "response" && typeof frame.id === "string") {
      const pending = this.pending.get(frame.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(frame.id);
      if (frame.success === false) pending.reject(new Error(String(frame.error ?? "RPC command failed.")));
      else pending.resolve(frame);
      return;
    }
    if (frame.type === "extension_ui_request" && typeof frame.id === "string") {
      const method = String(frame.method ?? "");
      if (["select", "confirm", "input", "editor"].includes(method)) {
        this.child?.stdin?.write(encodeJsonl({ type: "extension_ui_response", id: frame.id, cancelled: true }));
      }
    }
    this.options.onEvent?.(frame);
  }

  private async handleIpcFrame(frame: Record<string, unknown>): Promise<void> {
    if (frame.type !== "request" || typeof frame.id !== "string" || typeof frame.method !== "string") return;
    try {
      const params = frame.params && typeof frame.params === "object" && !Array.isArray(frame.params)
        ? frame.params as Record<string, unknown>
        : {};
      const result = await this.options.onIpcRequest?.(frame.method, params);
      this.sendIpc({ type: "response", id: frame.id, ok: true, result });
    } catch (error) {
      this.sendIpc({ type: "response", id: frame.id, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  private fail(error: unknown): void {
    const reason = error instanceof Error ? error : new Error(String(error));
    this.rejectPending(reason);
    this.options.onClose?.(reason);
    this.close();
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export function piInvocation(args: string[]): { command: string; args: string[] } {
  const script = process.argv[1];
  if (script && existsSync(script) && !script.startsWith("/$bunfs/")) {
    return { command: process.execPath, args: [script, ...args] };
  }
  const executable = basename(process.execPath).toLowerCase();
  return /^(node|bun)(\.exe)?$/.test(executable)
    ? { command: "pi", args }
    : { command: process.execPath, args };
}

export const CHILD_TOOL_NAMES = [
  "team_status",
  "team_claim_paths",
  "team_add_task",
  "team_complete",
  "team_send",
] as const;
export const WEB_TOOL_NAMES = ["web_search", "source_check", "fetch_content", "get_search_content"] as const;

const REVIEWED_TOOL_NAMES = new Set([
  "read", "bash", "grep", "find", "ls", "edit", "write", ...WEB_TOOL_NAMES,
]);

export function toolsForKind(
  kind: AgentKind,
  options: { mutating: boolean; finalize: boolean; requested?: readonly string[] },
): string[] {
  const defaults = options.mutating
    ? ["read", "bash", "grep", "find", "ls", "edit", "write"]
    : options.finalize
      ? ["read", "bash", "grep", "find", "ls"]
      : ["read", "grep", "find", "ls"];
  const selected = options.requested?.length ? options.requested : [...defaults, ...WEB_TOOL_NAMES];
  const allowed = selected.filter((name) => REVIEWED_TOOL_NAMES.has(name));
  const scoped = options.mutating
    ? allowed
    : allowed.filter((name) => name !== "edit" && name !== "write" && (options.finalize || name !== "bash"));
  return [...new Set([...scoped, ...CHILD_TOOL_NAMES])];
}

export function buildChildInvocation(options: {
  packageRoot: string;
  cwd: string;
  sessionDir: string;
  sessionFile?: string;
  agentId: string;
  agentName: string;
  taskId: string;
  kind: AgentKind;
  model: ModelRef;
  thinking: string;
  trustedProject: boolean;
  runtimeInstructions: string;
  mutating: boolean;
  finalize: boolean;
  tools?: readonly string[];
}): RpcInvocation {
  const selectedTools = toolsForKind(options.kind, {
    mutating: options.mutating,
    finalize: options.finalize,
    requested: options.tools,
  });
  const extensions = [options.packageRoot];
  const web = resolve(options.packageRoot, "..", "..", "pi-web-access");
  if (selectedTools.some((tool) => (WEB_TOOL_NAMES as readonly string[]).includes(tool)) && existsSync(web)) extensions.push(web);
  if (options.model.provider === "anthropic") {
    const auth = resolve(options.packageRoot, "..", "..", "@gotgenes", "pi-anthropic-auth");
    if (existsSync(auth)) extensions.push(auth);
  }
  const args = [
    "--mode", "rpc", "--session-dir", options.sessionDir,
    "--no-extensions", "--no-prompt-templates", "--no-themes",
  ];
  for (const extension of extensions) args.push("--extension", extension);
  if (options.trustedProject) args.push("--approve");
  if (options.sessionFile) args.push("--session", options.sessionFile);
  else args.push("--name", `agent-${options.agentName}`);
  args.push(
    "--model", `${options.model.provider}/${options.model.id}`,
    "--thinking", options.thinking,
    "--tools", selectedTools.join(","),
    "--append-system-prompt", options.runtimeInstructions,
  );
  const invocation = piInvocation(args);
  return {
    ...invocation,
    cwd: options.cwd,
    env: {
      ...process.env,
      PI_AGENTS_ROLE: "child",
      PI_AGENTS_AGENT_ID: options.agentId,
      PI_AGENTS_TASK_ID: options.taskId,
      PI_AGENTS_IPC_FD: "3",
    },
  };
}
