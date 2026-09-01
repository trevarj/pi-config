import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import net from "node:net";
import { resolve } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { JsonlDecoder, encodeJsonl } from "./rpc.ts";
import { normalizeToolPath, pathCovered } from "./leases.ts";

const MAX_MESSAGE_BYTES = 48 * 1024;
const GIT_BRANCH_COMMANDS = new Set([
  "checkout", "switch", "branch", "reset", "rebase", "merge", "cherry-pick", "revert", "clean", "worktree",
  "stash", "fetch", "pull", "update-ref", "notes", "tag", "remote", "config", "gc", "prune", "reflog",
]);
const GIT_READ_COMMANDS = new Set([
  "status", "diff", "log", "show", "rev-parse", "ls-files", "ls-tree", "cat-file", "grep", "blame", "describe",
  "name-rev", "shortlog", "whatchanged", "help", "version",
]);

interface TeamView {
  repoRoot: string;
  cwd: string;
  paths: string[];
  gitAuthority: "none" | "commit" | "full";
  reviewApproved: boolean;
  autoReview: boolean;
  canMutate?: boolean;
  inbox?: Array<{ from: string; text: string }>;
  [key: string]: unknown;
}

type GitOperation = "none" | "stage" | "commit" | "push" | "branch";

export function classifyGitCommand(command: string): GitOperation {
  // Match direct and wrapped/path-qualified invocations, including `sh -c` text.
  // False positives in echoed Git commands fail closed rather than bypass policy.
  const matches = [...command.matchAll(/(?:^|[\/\s;&|()'\"])(?:git)(?:\s+(?:-[cC]\s+\S+|--(?:git-dir|work-tree)(?:=\S+|\s+\S+)))*\s+([a-z-]+)\b/gim)];
  let operation: GitOperation = "none";
  for (const match of matches) {
    const subcommand = (match[1] ?? "").toLowerCase();
    if (subcommand === "push") return "push";
    if (subcommand === "commit") operation = "commit";
    else if (["add", "rm", "mv", "restore", "apply"].includes(subcommand) && operation === "none") operation = "stage";
    else if ((GIT_BRANCH_COMMANDS.has(subcommand) || !GIT_READ_COMMANDS.has(subcommand)) && operation === "none") operation = "branch";
  }
  return operation;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function shellWords(command: string): string[] {
  const words: string[] = [];
  let word = "";
  let quote: "'" | '"' | undefined;
  const push = () => { if (word) words.push(word); word = ""; };
  for (let index = 0; index < command.length; index++) {
    const character = command[index];
    if (quote) {
      if (character === quote) quote = undefined;
      else if (character === "\\" && quote === '"' && index + 1 < command.length) word += command[++index];
      else word += character;
    } else if (character === "'" || character === '"') quote = character;
    else if (character === "\\" && index + 1 < command.length) word += command[++index];
    else if (/\s/.test(character)) push();
    else word += character;
  }
  if (quote) throw new Error("Unterminated quote in git commit command.");
  push();
  return words;
}

export function rewriteSignedPathCommit(command: string, paths: readonly string[]): string {
  if (/[;&|()\n]/.test(command)) throw new Error("Complex shell commit commands are blocked; run one git commit command at a time.");
  const words = shellWords(command);
  while (words[0] === "command" || words[0] === "exec") words.shift();
  if (words.shift() !== "git" || words.shift() !== "commit") {
    throw new Error("Wrapped git commit commands cannot be made path-limited safely.");
  }
  const optionsWithValues = new Set([
    "-m", "--message", "-F", "--file", "-C", "--reuse-message", "-c", "--reedit-message",
    "--author", "--date", "--cleanup", "--fixup", "--squash", "--trailer",
  ]);
  const allowedFlags = new Set([
    "-a", "--all", "--amend", "--no-edit", "--allow-empty", "--allow-empty-message", "--signoff",
    "--no-verify", "--verbose", "--quiet", "--dry-run", "--reset-author", "--no-post-rewrite",
    "-S", "--gpg-sign",
  ]);
  const kept: string[] = [];
  let signed = false;
  for (let index = 0; index < words.length; index++) {
    const word = words[index];
    if (word === "--") break;
    const name = word.includes("=") ? word.slice(0, word.indexOf("=")) : word;
    if (/^-m.+/.test(word) || /^-S.+/.test(word)) {
      kept.push(word);
      signed ||= word.startsWith("-S");
      continue;
    }
    if (optionsWithValues.has(name)) {
      kept.push(word);
      signed ||= name === "-S" || name === "--gpg-sign";
      if (!word.includes("=")) {
        const value = words[++index];
        if (!value) throw new Error(`Git commit option ${word} requires a value.`);
        kept.push(value);
      }
      continue;
    }
    if (allowedFlags.has(word)) {
      kept.push(word);
      signed ||= word === "-S" || word === "--gpg-sign";
      continue;
    }
    throw new Error(`Git commit argument cannot be made path-limited safely: ${word}`);
  }
  const serialized = kept.map(shellQuote).join(" ");
  return `git commit${signed ? "" : " -S"}${serialized ? ` ${serialized}` : ""} --only -- ${paths.map(shellQuote).join(" ")}`;
}

class CollaborationClient {
  private sequence = 0;
  private pending = new Map<string, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  private readonly socket: net.Socket;

  constructor(fd: number) {
    this.socket = new net.Socket({ fd, readable: true, writable: true });
    const decoder = new JsonlDecoder((frame) => this.onFrame(frame));
    this.socket.on("data", (chunk) => {
      try { decoder.push(chunk); } catch (error) { this.rejectAll(error); }
    });
    this.socket.on("close", () => this.rejectAll(new Error("Parent collaboration channel closed.")));
    this.socket.on("error", (error) => this.rejectAll(error));
  }

  request(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
    const id = `ipc-${++this.sequence}`;
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectRequest(new Error(`Parent IPC ${method} timed out.`));
      }, 15_000);
      timer.unref();
      this.pending.set(id, { resolve: resolveRequest, reject: rejectRequest, timer });
      const onAbort = () => {
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(new DOMException("Aborted", "AbortError"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.socket.write(encodeJsonl({ type: "request", id, method, params }));
    });
  }

  private onFrame(frame: Record<string, unknown>): void {
    if (frame.type !== "response" || typeof frame.id !== "string") return;
    const pending = this.pending.get(frame.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(frame.id);
    if (frame.ok === false) pending.reject(new Error(String(frame.error ?? "Parent rejected IPC request.")));
    else pending.resolve(frame.result);
  }

  private rejectAll(error: unknown): void {
    const reason = error instanceof Error ? error : new Error(String(error));
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(reason);
    }
    this.pending.clear();
  }
}

function asTeamView(value: unknown): TeamView {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Parent returned invalid team status.");
  const view = value as TeamView;
  if (typeof view.repoRoot !== "string" || typeof view.cwd !== "string" || !Array.isArray(view.paths)) throw new Error("Parent returned incomplete team status.");
  return view;
}

function workingSnapshot(repoRoot: string, status: string): Map<string, string> {
  const result = new Map<string, string>();
  const records = status.split("\0");
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (!record || record.length < 4) continue;
    const code = record.slice(0, 2);
    const paths = [record.slice(3)];
    if (code.includes("R") || code.includes("C")) paths.push(records[++index] ?? "");
    for (const path of paths.filter(Boolean)) {
      const absolute = resolve(repoRoot, path);
      let fingerprint = `${code}:missing`;
      try {
        const stat = lstatSync(absolute);
        if (stat.isSymbolicLink()) fingerprint = `${code}:symlink`;
        else if (stat.isFile()) fingerprint = `${code}:${createHash("sha256").update(readFileSync(absolute)).digest("hex")}`;
        else fingerprint = `${code}:${stat.mode}:${stat.size}:${stat.mtimeMs}`;
      } catch { /* deletion remains missing */ }
      result.set(path.replaceAll("\\", "/"), fingerprint);
    }
  }
  return result;
}

function driftedPaths(before: Map<string, string>, after: Map<string, string>, leases: readonly string[]): string[] {
  const changed = new Set([...before.keys(), ...after.keys()]);
  return [...changed].filter((path) => before.get(path) !== after.get(path) && !pathCovered(path, leases));
}

export const CHILD_RUNTIME_INSTRUCTIONS = `# Pi team child
You are a logical child agent in a persistent Pi RPC session. Do not spawn or delegate to other agents.
Use team_status for current task, leases, mailbox, and Git authority. Claim paths before mutation with team_claim_paths. Direct edit/write outside your lease is blocked; shell changes are drift-checked. Never touch .git or traverse symlinks.
Use team_send for concise collaboration. You may add only bounded tasks within your current authority using team_add_task.
Finish exactly once with team_complete. Reviewers must return structured approved or changes_requested. Keep private reasoning private; send only findings, actions, and final output.`;

export interface ChildCollaborationPort {
  request(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
}

export default function childExtension(pi: ExtensionAPI): void {
  const fd = Number.parseInt(process.env.PI_AGENTS_IPC_FD ?? "", 10);
  if (!Number.isInteger(fd) || fd < 3) throw new Error("Pi child collaboration FD is missing.");
  registerChildRuntime(pi, new CollaborationClient(fd));
}

export function registerChildRuntime(
  pi: ExtensionAPI,
  client: ChildCollaborationPort,
  identity: { agentId?: string; taskId?: string } = {},
): void {
  const taskId = identity.taskId ?? process.env.PI_AGENTS_TASK_ID ?? "";
  const agentId = identity.agentId ?? process.env.PI_AGENTS_AGENT_ID ?? "";
  const bashState = new Map<string, { before: Map<string, string>; team: TeamView; gitToken?: string; operation: GitOperation }>();

  const request = (method: string, params: Record<string, unknown>, signal?: AbortSignal) =>
    client.request(method, { agentId, taskId, ...params }, signal);

  pi.registerCommand("pi-agents-child-status", {
    description: "Internal child-extension runtime probe",
    handler: async (_args, ctx) => {
      const result = await request("status", {});
      ctx.ui.notify(JSON.stringify(result), "info");
    },
  });

  pi.registerTool({
    name: "team_status",
    label: "Team Status",
    description: "Get current DAG status, your path leases, persistent mailbox, review state, and Git authority.",
    promptSnippet: "Use team_status to inspect current team work and your mailbox",
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute(_id, _params, signal) {
      const result = await request("status", {}, signal);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
    },
  });

  pi.registerTool({
    name: "team_claim_paths",
    label: "Claim Team Paths",
    description: "Claim normalized repository-relative file or directory prefixes before mutation. Overlaps queue; symlinks and .git are rejected.",
    parameters: Type.Object({
      paths: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 32 }),
      allowDirty: Type.Optional(Type.Boolean({ description: "Explicitly accept already dirty or staged paths." })),
    }, { additionalProperties: false }),
    async execute(_id, params, signal) {
      const result = await request("claim_paths", { paths: params.paths, allowDirty: params.allowDirty ?? false }, signal);
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    },
  });

  pi.registerTool({
    name: "team_add_task",
    label: "Add Team Task",
    description: "Add a bounded DAG task without increasing this agent's path or Git authority.",
    parameters: Type.Object({
      title: Type.Optional(Type.String()),
      prompt: Type.String({ minLength: 1, maxLength: MAX_MESSAGE_BYTES }),
      kind: Type.Optional(StringEnum(["explorer", "implementer", "reviewer", "general"] as const)),
      dependsOn: Type.Optional(Type.Array(Type.String(), { maxItems: 16 })),
      paths: Type.Optional(Type.Array(Type.String(), { maxItems: 32 })),
      mutating: Type.Optional(Type.Boolean()),
      autoReview: Type.Optional(Type.Boolean()),
    }, { additionalProperties: false }),
    async execute(_id, params, signal) {
      const result = await request("add_task", params, signal);
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    },
  });

  pi.registerTool({
    name: "team_complete",
    label: "Complete Team Task",
    description: "Complete or block the assigned task. Reviewers must include a structured review decision.",
    parameters: Type.Object({
      status: StringEnum(["completed", "blocked", "failed"] as const),
      summary: Type.String({ minLength: 1, maxLength: MAX_MESSAGE_BYTES }),
      review: Type.Optional(Type.Object({
        decision: StringEnum(["approved", "changes_requested"] as const),
        summary: Type.String({ minLength: 1, maxLength: MAX_MESSAGE_BYTES }),
        fingerprint: Type.Optional(Type.String({ maxLength: 128 })),
      }, { additionalProperties: false })),
    }, { additionalProperties: false }),
    async execute(_id, params, signal) {
      const result = await request("complete", params, signal);
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result,
        terminate: true,
      };
    },
  });

  pi.registerTool({
    name: "team_send",
    label: "Send Team Message",
    description: "Send a plain-text message to lead or a named logical agent's persistent mailbox.",
    parameters: Type.Object({
      to: Type.String({ minLength: 1, maxLength: 64 }),
      message: Type.String({ minLength: 1, maxLength: MAX_MESSAGE_BYTES }),
    }, { additionalProperties: false }),
    async execute(_id, params, signal) {
      const result = await request("send", params, signal);
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    },
  });

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === "edit" || event.toolName === "write") {
      const rawPath = String((event.input as { path?: unknown }).path ?? "");
      const team = asTeamView(await request("status", {}, ctx.signal));
      const path = normalizeToolPath(team.repoRoot, team.cwd, rawPath);
      await request("authorize_path", { path, tool: event.toolName }, ctx.signal);
      return;
    }
    if (event.toolName !== "bash") return;
    const command = String((event.input as { command?: unknown }).command ?? "");
    const team = asTeamView(await request("status", {}, ctx.signal));
    const operation = classifyGitCommand(command);
    let gitToken: string | undefined;
    if (operation === "branch") {
      if (team.gitAuthority !== "full") return { block: true, reason: "Branch-changing Git requires full authority." };
      if (!team.paths.includes(".")) return { block: true, reason: "Branch-changing Git requires the whole-repository lease '.'." };
      if (team.autoReview && !team.reviewApproved) return { block: true, reason: "Branch-changing Git is deferred until automatic review is approved." };
    } else if (operation === "stage") {
      if (team.gitAuthority === "none") return { block: true, reason: "Index-changing Git requires commit or full authority." };
    } else if (operation === "commit") {
      if (team.gitAuthority === "none") return { block: true, reason: "This task has no commit authority." };
      try {
        (event.input as { command: string }).command = rewriteSignedPathCommit(command, team.paths);
      } catch (error) {
        return { block: true, reason: error instanceof Error ? error.message : String(error) };
      }
    } else if (operation === "push") {
      if (team.gitAuthority !== "full") return { block: true, reason: "Git push requires full authority." };
      if (team.autoReview && !team.reviewApproved) return { block: true, reason: "Push is deferred until automatic review is approved." };
    }
    if (operation !== "none") {
      gitToken = event.toolCallId;
      await request("git_lock", { operation, token: gitToken }, ctx.signal);
    }
    const result = await pi.exec("git", ["-C", team.repoRoot, "status", "--porcelain=v1", "-z", "--untracked-files=all"], { signal: ctx.signal, timeout: 5_000 });
    bashState.set(event.toolCallId, { before: workingSnapshot(team.repoRoot, result.stdout), team, gitToken, operation });
  });

  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "bash") return;
    const state = bashState.get(event.toolCallId);
    if (!state) return;
    bashState.delete(event.toolCallId);
    try {
      const result = await pi.exec("git", ["-C", state.team.repoRoot, "status", "--porcelain=v1", "-z", "--untracked-files=all"], { signal: ctx.signal, timeout: 5_000 });
      const allowedPaths = state.team.canMutate === false && state.operation === "none" ? [] : state.team.paths;
      const outside = driftedPaths(state.before, workingSnapshot(state.team.repoRoot, result.stdout), allowedPaths);
      if (outside.length) {
        await request("drift", { paths: outside.slice(0, 64) }, ctx.signal);
        ctx.abort();
        return {
          content: [...event.content, { type: "text" as const, text: `\nPaused: shell changed paths outside the lease: ${outside.join(", ")}` }],
          isError: true,
        };
      }
    } finally {
      if (state.gitToken) await request("git_unlock", { token: state.gitToken }).catch(() => undefined);
    }
  });
}
