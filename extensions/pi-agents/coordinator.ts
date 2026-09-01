import { createHash, randomUUID } from "node:crypto";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionManager, sessionEntryToContextMessages, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CHILD_RUNTIME_INSTRUCTIONS } from "./child.ts";
import { buildDelegatedContext, redactSecrets, truncateUtf8 } from "./context.ts";
import {
  acquireLease,
  conflictingLease,
  dirtyConflict,
  normalizeLeasePath,
  normalizeToolPath,
  parseGitStatusZ,
  pathCovered,
  releaseLease,
} from "./leases.ts";
import { RpcProcess, buildChildInvocation } from "./rpc.ts";
import {
  allTasksTerminal,
  buildAtomicPlan,
  createEmptyState,
  dependenciesReady,
  dependencyFailure,
  resolveModelQuery,
  reviewLoopGuard,
  roleMatches,
  safeId,
} from "./scheduler.ts";
import {
  markTerminal,
  pruneTerminalStates,
  readState,
  recoverState,
  statePath,
  stateRoot,
  writeStateAtomic,
} from "./state.ts";
import {
  MAX_ACTIVE_TURNS,
  MAX_AGENTS,
  MAX_TASKS,
  type ActionRecord,
  type AgentInput,
  type AgentRecord,
  type GitAuthority,
  type MailMessage,
  type ModelRef,
  type PrivacySnapshot,
  type ReviewResult,
  type TaskInput,
  type TaskRecord,
  type TeamState,
  isTaskTerminal,
} from "./types.ts";
import { AgentsDashboard, type DashboardAction, panelSummary } from "./ui.ts";

const PACKAGE_ROOT = dirname(fileURLToPath(import.meta.url));
const ACTION_LIMIT = 500;
const OUTPUT_LIMIT = 12 * 1024;
const SNAPSHOT_FILE_LIMIT = 256 * 1024;
const SNAPSHOT_TOTAL_LIMIT = 2 * 1024 * 1024;

interface Completion {
  status: "completed" | "blocked" | "failed";
  summary: string;
  review?: ReviewResult;
}

interface ActiveRun {
  agentId: string;
  taskId: string;
  phase: TaskRecord["phase"];
  rpc: RpcProcess;
  completion?: Completion;
  lastText?: string;
  lastError?: string;
  stopReason?: string;
  ended: boolean;
  deadline?: NodeJS.Timeout;
}

interface WaitRegistration {
  predicate: () => boolean;
  resolve: () => void;
}

interface GitWaiter {
  token: string;
  agentId: string;
  run: ActiveRun;
  resolve: () => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

function now(): string {
  return new Date().toISOString();
}

function authorityRank(authority: GitAuthority): number {
  return authority === "full" ? 2 : authority === "commit" ? 1 : 0;
}

function parentAuthority(branch: readonly unknown[]): GitAuthority {
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index] as { type?: unknown; customType?: unknown; data?: { mode?: unknown } };
    if (entry?.type !== "custom" || entry.customType !== "work-mode") continue;
    return entry.data?.mode === "vibe-solo" || entry.data?.mode === "vibe-quick" ? "full" : "none";
  }
  return "none";
}

function assistantText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const value = message as { role?: unknown; content?: unknown; stopReason?: unknown; errorMessage?: unknown };
  if (value.role !== "assistant" || !Array.isArray(value.content)) return "";
  return value.content
    .filter((block): block is { type: string; text?: string } => !!block && typeof block === "object")
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n\n")
    .trim();
}

function isRecoverable(message: string): boolean {
  return /closed|exited|timeout|timed out|econn|terminated|overload|rate.?limit|without required team_complete|\b5\d\d\b/i.test(message);
}

export function privacySnapshot(state: TeamState): PrivacySnapshot {
  return {
    version: 1,
    active: state.agents.filter((agent) => agent.status === "running").length,
    queued: state.tasks.filter((task) => task.status === "queued" || task.status === "waiting").length,
    blocked: state.tasks.filter((task) => task.status === "blocked" || task.status === "failed").length,
    agents: state.agents.slice(0, MAX_AGENTS).map((agent) => ({
      id: agent.id,
      name: agent.name,
      kind: agent.kind,
      status: agent.status,
      taskId: agent.taskId,
      model: agent.model,
    })),
    tasks: state.tasks.slice(0, MAX_TASKS).map((task) => ({
      id: task.id,
      title: task.title,
      status: task.status,
      agentId: task.agentId,
      dependsOn: task.dependsOn,
    })),
  };
}

export class Coordinator {
  private readonly pi: ExtensionAPI;
  private state?: TeamState;
  private path?: string;
  private ctx?: ExtensionContext;
  private parentModel?: ModelRef;
  private parentThinking = "off";
  private trustedProject = false;
  private dirtyPaths: string[] = [];
  private readonly runs = new Map<string, ActiveRun>();
  private readonly waits = new Set<WaitRegistration>();
  private readonly gitWaiters: GitWaiter[] = [];
  private readonly gitTokens = new Map<string, ActiveRun>();
  private scheduling = false;
  private reschedule = false;
  private shuttingDown = false;

  constructor(pi: ExtensionAPI) {
    this.pi = pi;
  }

  get current(): TeamState {
    if (!this.state) throw new Error("Pi agents are not initialized for this session.");
    return this.state;
  }

  get models(): ModelRef[] {
    const available = this.ctx?.modelRegistry.getAvailable() ?? [];
    return available.map((model) => ({
      provider: model.provider,
      id: model.id,
      name: model.name,
      thinkingLevels: getSupportedThinkingLevels(model),
    }));
  }

  async start(ctx: ExtensionContext): Promise<void> {
    this.ctx = ctx;
    this.shuttingDown = false;
    this.parentModel = ctx.model ? {
      provider: ctx.model.provider,
      id: ctx.model.id,
      name: ctx.model.name,
      thinkingLevels: getSupportedThinkingLevels(ctx.model),
    } : undefined;
    this.parentThinking = ctx.thinkingLevel ?? "off";
    this.trustedProject = ctx.isProjectTrusted();
    pruneTerminalStates();
    const repoRootResult = await this.pi.exec("git", ["rev-parse", "--show-toplevel"], { timeout: 5_000 });
    const repoRoot = repoRootResult.code === 0 ? repoRootResult.stdout.trim() : ctx.cwd;
    const sessionId = ctx.sessionManager.getSessionId();
    this.path = statePath(sessionId);
    const saved = readState(this.path);
    let shouldSchedule = !saved;
    if (saved) {
      this.state = recoverState(saved);
      this.persist();
      if (saved.tasks.some((task) => !isTaskTerminal(task.status))) shouldSchedule = await this.recover(ctx);
    } else {
      this.state = createEmptyState(sessionId, ctx.cwd, repoRoot);
      this.persist();
    }
    await this.refreshDirty();
    this.publish();
    if (shouldSchedule) this.schedule();
  }

  updateParent(ctx: ExtensionContext): void {
    this.ctx = ctx;
    this.parentModel = ctx.model ? {
      provider: ctx.model.provider,
      id: ctx.model.id,
      name: ctx.model.name,
      thinkingLevels: getSupportedThinkingLevels(ctx.model),
    } : undefined;
    this.parentThinking = ctx.thinkingLevel ?? "off";
  }

  private currentAuthority(): GitAuthority {
    return this.ctx ? parentAuthority(this.ctx.sessionManager.getBranch()) : "none";
  }

  private async recover(ctx: ExtensionContext): Promise<boolean> {
    if (!ctx.hasUI || ctx.mode === "json" || ctx.mode === "print") return false;
    const choice = await ctx.ui.select("Recover paused Pi agents", [
      "resume paused work",
      "cancel unfinished work",
      "leave paused",
    ]);
    if (choice?.startsWith("resume")) {
      for (const task of this.current.tasks) if (task.status === "paused") task.status = "queued";
      for (const agent of this.current.agents) if (agent.status === "paused") agent.status = "hibernated";
      this.action("recovery", undefined, undefined, "resumed paused work");
      this.persist();
      return true;
    } else if (choice?.startsWith("cancel")) {
      for (const task of this.current.tasks) if (!isTaskTerminal(task.status)) task.status = "stopped";
      for (const agent of this.current.agents) if (agent.status === "paused") agent.status = "stopped";
      this.current.leases = [];
      this.action("recovery", undefined, undefined, "cancelled unfinished work");
    }
    this.persist();
    return false;
  }

  async authorizeElevation(tasks: readonly TaskInput[], ctx: ExtensionContext): Promise<void> {
    const currentAuthority = parentAuthority(ctx.sessionManager.getBranch());
    const requested = tasks.reduce<GitAuthority>((highest, task) =>
      authorityRank(task.gitAuthority ?? currentAuthority) > authorityRank(highest)
        ? task.gitAuthority ?? currentAuthority
        : highest, currentAuthority);
    if (authorityRank(requested) <= authorityRank(currentAuthority)) return;
    if (!ctx.hasUI || ctx.mode === "json" || ctx.mode === "print") {
      throw new Error(`Git authority elevation to ${requested} is denied without immediate UI confirmation.`);
    }
    const allowed = await ctx.ui.confirm(
      "Elevate child Git authority",
      `Allow ${requested} authority for these delegated tasks? Child messages cannot elevate it later.`,
    );
    if (!allowed) throw new Error(`Git authority elevation to ${requested} was denied.`);
  }

  addPlan(agents: AgentInput[], tasks: TaskInput[]): { agentIds: string[]; taskIds: string[] } {
    if (!agents.length) throw new Error("subagent_spawn requires a non-empty agents[] array.");
    const plan = buildAtomicPlan({
      state: this.current,
      agents,
      tasks,
      models: this.models,
      parentModel: this.parentModel,
      parentThinking: this.parentThinking,
      defaultAuthority: this.currentAuthority(),
    });
    this.normalizeTaskPaths(plan.tasks);
    this.current.agents.push(...plan.agents);
    this.current.tasks.push(...plan.tasks);
    this.action("spawn", undefined, undefined, `${plan.agents.length} agents, ${plan.tasks.length} tasks`);
    this.persist();
    this.schedule();
    return { agentIds: plan.agents.map((agent) => agent.id), taskIds: plan.tasks.map((task) => task.id) };
  }

  addTasks(tasks: TaskInput[], defaultAgent?: string): string[] {
    const inputs = tasks.map((task) => ({ ...task, agent: task.agent ?? defaultAgent }));
    const plan = buildAtomicPlan({
      state: this.current,
      agents: [],
      tasks: inputs,
      models: this.models,
      parentModel: this.parentModel,
      parentThinking: this.parentThinking,
      defaultAuthority: this.currentAuthority(),
    });
    this.normalizeTaskPaths(plan.tasks);
    this.current.tasks.push(...plan.tasks);
    this.action("add_tasks", undefined, undefined, `${plan.tasks.length} tasks`);
    this.persist();
    this.schedule();
    return plan.tasks.map((task) => task.id);
  }

  private normalizeTaskPaths(tasks: TaskRecord[]): void {
    for (const task of tasks) task.paths = task.paths.map((path) => normalizeLeasePath(this.current.repoRoot, path));
  }

  inspect(id?: string): unknown {
    if (!id) return {
      snapshot: privacySnapshot(this.current),
      leases: this.current.leases,
      recentActions: this.current.actions.slice(-30),
    };
    const agent = this.findAgent(id);
    if (agent) return {
      ...agent,
      tasks: this.current.tasks.filter((task) => task.agentId === agent.id),
      mailbox: this.current.mailboxes[agent.id] ?? [],
      actions: this.current.actions.filter((action) => action.agentId === agent.id).slice(-50),
    };
    const task = this.findTask(id);
    if (task) return {
      ...task,
      prompt: truncateUtf8(redactSecrets(task.prompt), OUTPUT_LIMIT),
      lease: this.current.leases.find((lease) => lease.taskId === task.id),
      actions: this.current.actions.filter((action) => action.taskId === task.id).slice(-50),
    };
    throw new Error(`Unknown agent or task: ${id}`);
  }

  send(to: string, message: string, from = "lead"): string {
    const target = to === "lead" ? "lead" : this.findAgent(to)?.id;
    if (!target) throw new Error(`Unknown mailbox: ${to}`);
    const record: MailMessage = {
      id: randomUUID(),
      from,
      to: target,
      text: truncateUtf8(redactSecrets(message), 48 * 1024),
      createdAt: now(),
    };
    (this.current.mailboxes[target] ??= []).push(record);
    this.current.mailboxes[target] = this.current.mailboxes[target].slice(-100);
    const run = this.runs.get(target);
    if (run && from === "lead") void run.rpc.steer(`Team message from lead: ${record.text}`).catch(() => undefined);
    if (target === "lead" && from !== "lead") this.wakeLead(`Agent ${from} sent a team message: ${record.text}`);
    this.action("message", from === "lead" ? target : from, undefined, `${from} → ${target}: ${record.text}`);
    this.persist();
    return record.id;
  }

  async manage(options: {
    action: "pause" | "resume" | "retry" | "reconfigure" | "stop" | "set_concurrency";
    target?: string;
    model?: string;
    thinking?: string;
    concurrency?: number;
  }): Promise<void> {
    if (options.action === "set_concurrency") {
      if (!Number.isInteger(options.concurrency) || (options.concurrency ?? 0) < 1 || (options.concurrency ?? 0) > MAX_AGENTS) {
        throw new Error(`Concurrency must be an integer from 1 to ${MAX_AGENTS}.`);
      }
      this.current.maxConcurrent = options.concurrency!;
      this.action(options.action, undefined, undefined, String(options.concurrency));
      this.persist();
      this.schedule();
      return;
    }
    if (!options.target) throw new Error(`${options.action} requires a target.`);
    const agent = this.findAgent(options.target);
    const task = this.findTask(options.target) ?? (agent?.taskId ? this.findTask(agent.taskId) : undefined);
    if (!agent && !task) throw new Error(`Unknown agent or task: ${options.target}`);
    const owner = agent ?? (task?.agentId ? this.findAgent(task.agentId) : undefined);
    if (options.action === "pause") {
      if (task && !isTaskTerminal(task.status)) task.status = "paused";
      if (owner) owner.status = "paused";
      if (owner) this.endRun(owner.id, "pause");
    } else if (options.action === "resume") {
      if (task?.status === "paused" || task?.status === "waiting") task.status = "queued";
      if (owner?.status === "paused") owner.status = "hibernated";
    } else if (options.action === "retry") {
      if (!task) throw new Error("Retry requires a task target or an agent with an assigned task.");
      if (!["failed", "blocked", "paused", "stopped"].includes(task.status)) throw new Error(`Task ${task.id} is not retryable from ${task.status}.`);
      task.status = "queued";
      task.error = undefined;
      task.finishedAt = undefined;
      if (owner) owner.status = "hibernated";
    } else if (options.action === "reconfigure") {
      if (!owner) throw new Error("Reconfigure requires an agent.");
      if (owner.status === "running") throw new Error("Pause the agent before reconfiguration.");
      if (options.model) owner.model = resolveModelQuery(options.model, this.models, this.parentModel);
      if (options.thinking) owner.thinking = options.thinking;
    } else {
      if (task && !isTaskTerminal(task.status)) {
        task.status = "stopped";
        task.finishedAt = now();
        this.current.leases = releaseLease(this.current.leases, task.id);
      }
      if (owner) {
        owner.status = "stopped";
        this.endRun(owner.id, "stop");
      }
    }
    this.action(options.action, owner?.id, task?.id);
    this.persist();
    this.schedule();
  }

  wait(ids: string[], mode: "all" | "any", timeoutSeconds: number, signal?: AbortSignal): Promise<boolean> {
    const selected = ids.length ? ids.map((id) => this.findTask(id) ?? (() => { throw new Error(`Unknown task: ${id}`); })()) : this.current.tasks;
    const predicate = () => mode === "all"
      ? selected.every((task) => isTaskTerminal(task.status) || task.status === "blocked")
      : selected.some((task) => isTaskTerminal(task.status) || task.status === "blocked");
    if (predicate()) return Promise.resolve(true);
    return new Promise((resolveWait, rejectWait) => {
      let settled = false;
      const registration: WaitRegistration = {
        predicate,
        resolve: () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          this.waits.delete(registration);
          resolveWait(true);
        },
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.waits.delete(registration);
        resolveWait(false);
      }, Math.max(0, timeoutSeconds) * 1000);
      timer.unref();
      signal?.addEventListener("abort", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.waits.delete(registration);
        rejectWait(new DOMException("Aborted", "AbortError"));
      }, { once: true });
      this.waits.add(registration);
    });
  }

  private checkWaits(): void {
    for (const wait of [...this.waits]) if (wait.predicate()) wait.resolve();
  }

  private schedule(): void {
    if (this.shuttingDown || !this.state) return;
    if (this.scheduling) {
      this.reschedule = true;
      return;
    }
    this.scheduling = true;
    queueMicrotask(async () => {
      try {
        await this.scheduleLoop();
      } finally {
        this.scheduling = false;
        if (this.reschedule) {
          this.reschedule = false;
          this.schedule();
        }
      }
    });
  }

  private async scheduleLoop(): Promise<void> {
    let changed = false;
    for (const task of this.current.tasks) {
      if (task.status !== "queued" && task.status !== "waiting" && task.status !== "reviewing") continue;
      const failure = dependencyFailure(task, this.current.tasks);
      if (failure) {
        task.status = "blocked";
        task.error = failure;
        task.finishedAt = now();
        this.wakeLead(`Task ${task.id} is blocked: ${failure}`);
        changed = true;
      }
    }
    const attempted = new Set<string>();
    while (this.runs.size < Math.min(MAX_AGENTS, this.current.maxConcurrent ?? MAX_ACTIVE_TURNS)) {
      const task = this.current.tasks.find((candidate) => !attempted.has(candidate.id) && this.canRun(candidate));
      if (!task) break;
      attempted.add(task.id);
      const previousStatus = task.status;
      const started = await this.startTask(task);
      if (!started) {
        if (task.status === "queued" || task.status === "waiting") task.status = "waiting";
        if (task.status !== previousStatus) changed = true;
        continue;
      }
      changed = true;
    }
    if (changed) this.persist();
  }

  private canRun(task: TaskRecord): boolean {
    if (task.status !== "queued" && task.status !== "waiting" && task.status !== "reviewing") return false;
    if (this.runsHasTask(task.id)) return false;
    if (!dependenciesReady(task, this.current.tasks)) return false;
    if (task.startedAt && Date.now() - Date.parse(task.startedAt) >= task.timeoutMs) {
      this.failTask(task, `Task exceeded the ${Math.round(task.timeoutMs / 60_000)} minute total budget.`);
      this.persist();
      return false;
    }
    if (task.turns >= task.maxTurns) {
      this.failTask(task, `Task exceeded the ${task.maxTurns} turn total budget.`);
      this.persist();
      return false;
    }
    return true;
  }

  private async startTask(task: TaskRecord): Promise<boolean> {
    const phase = task.phase;
    const agent = phase === "review" ? this.selectReviewer(task) : this.selectAgent(task);
    if (!agent || agent.status === "paused" || agent.status === "stopped" || this.runs.has(agent.id)) return false;
    if (task.mutating && phase !== "review" && !this.current.leases.some((lease) => lease.taskId === task.id)) {
      const conflict = conflictingLease(task.paths, this.current.leases, task.id);
      if (conflict) return false;
      await this.refreshDirty();
      const dirty = !task.allowDirty ? dirtyConflict(task.paths, this.dirtyPaths) : undefined;
      if (dirty) {
        task.status = "blocked";
        task.error = `Path ${dirty} is dirty or staged; set allowDirty explicitly.`;
        this.wakeLead(`Task ${task.id} is blocked: ${task.error}`);
        return false;
      }
      this.current.leases = acquireLease(this.current.leases, {
        taskId: task.id,
        agentId: task.agentId ?? agent.id,
        paths: task.paths,
        acquiredAt: now(),
      }, this.dirtyPaths, task.allowDirty);
    }
    if (task.mutating && phase === "implement" && !task.baseline) {
      task.baseline = await this.captureBaseline(task);
    }
    if (!task.startedAt) task.startedAt = now();
    task.attempts++;
    task.updatedAt = now();
    task.status = phase === "review" ? "reviewing" : phase === "fix" ? "fixing" : phase === "finalize" ? "finalizing" : "running";
    agent.status = "running";
    agent.taskId = task.id;
    agent.updatedAt = now();
    if (phase !== "review") task.agentId = agent.id;
    else task.reviewAgentId = agent.id;
    const gitSummary = await this.gitSummary();
    const prompt = await this.runPrompt(task, agent, gitSummary);
    const sessionDir = join(stateRoot(this.current.parentSessionId), "sessions");
    mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
    if (!agent.sessionFile && task.contextMode === "full" && this.ctx) {
      const seeded = SessionManager.create(this.current.cwd, sessionDir);
      const messages = this.ctx.sessionManager.buildContextEntries().flatMap(sessionEntryToContextMessages);
      for (const message of messages) {
        if (message.role === "branchSummary" || message.role === "compactionSummary") {
          seeded.appendMessage({
            role: "user",
            content: `[${message.role}] ${message.summary}`,
            timestamp: message.timestamp,
          });
        } else {
          seeded.appendMessage(message);
        }
      }
      agent.sessionFile = seeded.getSessionFile();
    }
    const invocation = buildChildInvocation({
      packageRoot: PACKAGE_ROOT,
      cwd: this.current.cwd,
      sessionDir,
      sessionFile: agent.sessionFile,
      agentId: agent.id,
      agentName: agent.name,
      taskId: task.id,
      kind: phase === "review" ? "reviewer" : agent.kind,
      model: agent.model,
      thinking: agent.thinking,
      trustedProject: this.trustedProject,
      runtimeInstructions: [
        CHILD_RUNTIME_INSTRUCTIONS,
        `Current role: ${agent.kind}. Current phase: ${phase}.`,
        agent.instructions,
      ].filter(Boolean).join("\n\n"),
      mutating: task.mutating && phase !== "review" && phase !== "finalize",
      finalize: phase === "finalize",
      tools: agent.tools,
    });
    let run!: ActiveRun;
    const rpc = new RpcProcess({
      invocation,
      onEvent: (event) => this.onChildEvent(run, event),
      onIpcRequest: (method, params) => this.onChildRequest(run, method, params),
      onClose: (error) => this.onChildClose(run, error),
    });
    run = { agentId: agent.id, taskId: task.id, phase, rpc, ended: false };
    const remaining = task.timeoutMs - (Date.now() - Date.parse(task.startedAt));
    run.deadline = setTimeout(() => {
      if (run.ended) return;
      this.handleRunFailure(run, `Task exceeded the ${Math.round(task.timeoutMs / 60_000)} minute total budget.`);
    }, Math.max(1, remaining));
    run.deadline.unref();
    this.runs.set(agent.id, run);
    this.action("start", agent.id, task.id, `${phase}: ${task.title}`);
    this.persist();
    try {
      const childState = await rpc.start();
      if (typeof childState.sessionFile === "string") agent.sessionFile = childState.sessionFile;
      if (typeof childState.thinkingLevel === "string") agent.thinking = childState.thinkingLevel;
      const actualModel = childState.model as { provider?: unknown; id?: unknown; name?: unknown } | undefined;
      if (typeof actualModel?.provider === "string" && typeof actualModel.id === "string") {
        agent.model = { provider: actualModel.provider, id: actualModel.id, name: typeof actualModel.name === "string" ? actualModel.name : undefined };
      }
      this.persist();
      await rpc.prompt(prompt);
      return true;
    } catch (error) {
      this.handleRunFailure(run, error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  private async runPrompt(task: TaskRecord, agent: AgentRecord, gitSummary: string): Promise<string> {
    const base = buildDelegatedContext({
      task: task.prompt,
      branch: this.ctx?.sessionManager.getBranch() ?? [],
      gitSummary,
      mode: task.contextMode === "full" ? "fresh" : task.contextMode,
    });
    const mailbox = (this.current.mailboxes[agent.id] ?? []).filter((message) => !message.readAt);
    for (const message of mailbox) message.readAt = now();
    const messages = mailbox.length ? `\n\n# Team mailbox\n${mailbox.map((message) => `${message.from}: ${message.text}`).join("\n")}` : "";
    if (task.phase === "review") {
      const snapshot = task.reviewSnapshot;
      return `${base}${messages}\n\n# Review assignment\nReview the current checkout against this stable task snapshot. Do not mutate files. Return team_complete with review.decision approved or changes_requested and a concise material-finding summary.\n\n${JSON.stringify(snapshot, null, 2)}`;
    }
    if (task.phase === "fix") {
      return `${base}${messages}\n\n# Fix cycle\nAddress this structured review without expanding scope, then call team_complete:\n${JSON.stringify(task.review, null, 2)}`;
    }
    if (task.phase === "finalize") {
      return `${base}${messages}\n\n# Approved finalize\nAutomatic review approved the current diff. Only now perform any authorized signed path-limited commit or push explicitly required by the task, verify final state, then call team_complete.`;
    }
    return `${base}${messages}\n\nCall team_complete when this assignment is finished or blocked.`;
  }

  private selectAgent(task: TaskRecord): AgentRecord | undefined {
    if (task.agentId) return this.findAgent(task.agentId);
    const agent = this.current.agents.find((candidate) =>
      !this.runs.has(candidate.id)
      && ["queued", "idle", "hibernated"].includes(candidate.status)
      && roleMatches(candidate, task),
    );
    if (agent) task.agentId = agent.id;
    return agent;
  }

  private selectReviewer(task: TaskRecord): AgentRecord | undefined {
    if (task.reviewAgentId) {
      const existing = this.findAgent(task.reviewAgentId);
      if (existing && !this.runs.has(existing.id)) return existing;
    }
    const reviewer = this.current.agents.find((candidate) =>
      candidate.id !== task.agentId
      && !this.runs.has(candidate.id)
      && ["reviewer", "general"].includes(candidate.kind)
      && ["queued", "idle", "hibernated"].includes(candidate.status),
    );
    if (reviewer) return reviewer;
    if (this.current.agents.length >= MAX_AGENTS || !this.parentModel) {
      this.failTask(task, this.current.agents.length >= MAX_AGENTS
        ? "Automatic review could not allocate a reviewer within the 16 agent cap."
        : "Automatic review could not inherit a parent model.");
      return undefined;
    }
    const timestamp = now();
    const ephemeral: AgentRecord = {
      id: safeId(`reviewer-${task.id}`, "reviewer"),
      name: `reviewer-${task.id}`,
      kind: "reviewer",
      model: { ...this.parentModel },
      thinking: this.parentThinking,
      instructions: "Review only material correctness findings and use structured team_complete.",
      lifetime: "task",
      status: "queued",
      ephemeral: true,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    if (this.current.agents.some((agent) => agent.id === ephemeral.id)) ephemeral.id = safeId(`${ephemeral.id}-${randomUUID().slice(0, 6)}`, "reviewer");
    this.current.agents.push(ephemeral);
    return ephemeral;
  }

  private onChildEvent(run: ActiveRun, event: Record<string, unknown>): void {
    if (!run || run.ended) return;
    const task = this.findTask(run.taskId);
    const agent = this.findAgent(run.agentId);
    if (!task || !agent) return;
    if (event.type === "turn_start" && task.turns >= task.maxTurns) {
      this.handleRunFailure(run, `Task exceeded the ${task.maxTurns} turn total budget.`);
    } else if (event.type === "turn_end") {
      task.turns++;
    } else if (event.type === "tool_execution_start") {
      this.action("tool", agent.id, task.id, String(event.toolName ?? "tool"));
    } else if (event.type === "tool_execution_end") {
      const result = event.result as { content?: unknown } | undefined;
      const output = Array.isArray(result?.content)
        ? result.content.filter((block): block is { type: string; text?: string } => !!block && typeof block === "object" && (block as { type?: unknown }).type === "text").map((block) => block.text ?? "").join("\n")
        : "";
      this.action("tool_result", agent.id, task.id, output || String(event.toolName ?? "tool"), event.isError === true);
    } else if (event.type === "message_end") {
      const text = assistantText(event.message);
      if (text) {
        run.lastText = text;
        agent.lastOutput = truncateUtf8(redactSecrets(text), OUTPUT_LIMIT);
        this.action("output", agent.id, task.id, agent.lastOutput);
      }
      const message = event.message as { stopReason?: unknown; errorMessage?: unknown } | undefined;
      if (typeof message?.stopReason === "string") run.stopReason = message.stopReason;
      if (typeof message?.errorMessage === "string") run.lastError = message.errorMessage;
    } else if (event.type === "agent_settled") {
      void this.settleRun(run);
    }
    this.persist();
  }

  private async onChildRequest(run: ActiveRun, method: string, params: Record<string, unknown>): Promise<unknown> {
    if (!run || run.ended) throw new Error("This child run is no longer active.");
    const task = this.findTask(run.taskId);
    const agent = this.findAgent(run.agentId);
    if (!task || !agent) throw new Error("Child task no longer exists.");
    const canMutate = run.phase !== "review" && run.phase !== "finalize" && task.mutating;
    if (method === "status") {
      const inbox = (this.current.mailboxes[agent.id] ?? []).filter((message) => !message.readAt);
      for (const message of inbox) message.readAt = now();
      this.persist();
      return {
        agent: { id: agent.id, name: agent.name, kind: agent.kind, status: agent.status },
        task: { id: task.id, title: task.title, status: task.status, phase: task.phase, dependsOn: task.dependsOn },
        tasks: this.current.tasks.map((item) => ({ id: item.id, title: item.title, status: item.status, agentId: item.agentId })),
        repoRoot: this.current.repoRoot,
        cwd: this.current.cwd,
        paths: this.current.leases.find((lease) => lease.taskId === task.id)?.paths ?? [],
        gitAuthority: canMutate ? task.gitAuthority : "none",
        autoReview: task.autoReview,
        reviewApproved: task.review?.decision === "approved" && task.phase === "finalize",
        canMutate,
        inbox: inbox.map((message) => ({ from: message.from, text: message.text })),
      };
    }
    if (method === "claim_paths") {
      if (!canMutate) throw new Error("This agent phase has no mutation authority.");
      const requested = Array.isArray(params.paths) ? params.paths.map(String) : [];
      const paths = requested.map((path) => normalizeLeasePath(this.current.repoRoot, path));
      if (!paths.length) throw new Error("At least one path is required.");
      const combined = [...new Set([...task.paths, ...paths])];
      const conflict = conflictingLease(combined, this.current.leases, task.id);
      if (conflict) return { queued: true, behindTask: conflict.taskId };
      await this.refreshDirty();
      const allowDirty = params.allowDirty === true;
      const dirty = !allowDirty ? dirtyConflict(paths, this.dirtyPaths) : undefined;
      if (dirty) throw new Error(`Path ${dirty} is dirty or staged; set allowDirty explicitly.`);
      task.paths = combined;
      task.allowDirty ||= allowDirty;
      this.current.leases = acquireLease(this.current.leases, {
        taskId: task.id,
        agentId: task.agentId ?? agent.id,
        paths: combined,
        acquiredAt: now(),
      }, this.dirtyPaths, task.allowDirty);
      this.action("lease", agent.id, task.id, combined.join(", "));
      this.persist();
      return { queued: false, paths: combined };
    }
    if (method === "authorize_path") {
      if (!canMutate) throw new Error("This agent phase has no mutation authority.");
      const path = normalizeLeasePath(this.current.repoRoot, String(params.path ?? ""));
      const paths = this.current.leases.find((lease) => lease.taskId === task.id)?.paths ?? [];
      if (!pathCovered(path, paths)) throw new Error(`${String(params.tool)} path ${path} is outside this task's lease.`);
      return { path };
    }
    if (method === "add_task") {
      if (params.mutating === true && !canMutate) throw new Error("This child phase cannot create mutating tasks.");
      const requestedPaths = Array.isArray(params.paths) ? params.paths.map(String) : [];
      const normalized = requestedPaths.map((path) => normalizeLeasePath(this.current.repoRoot, path));
      if (params.mutating === true && normalized.length === 0) {
        throw new Error("Child-created mutating tasks require explicit non-empty paths.");
      }
      if (normalized.some((path) => !pathCovered(path, task.paths))) throw new Error("Child-created task paths must stay within the caller's lease.");
      const ids = this.addTasks([{
        title: typeof params.title === "string" ? params.title : undefined,
        prompt: String(params.prompt ?? ""),
        kind: params.kind as TaskInput["kind"],
        dependsOn: Array.isArray(params.dependsOn) ? params.dependsOn.map(String) : [task.id],
        paths: normalized,
        mutating: params.mutating === true,
        autoReview: task.autoReview ? true : params.autoReview !== false,
        gitAuthority: task.gitAuthority,
      }]);
      return { taskIds: ids };
    }
    if (method === "complete") {
      if (run.completion) throw new Error("team_complete was already accepted for this run.");
      const reviewValue = params.review as ReviewResult | undefined;
      run.completion = {
        status: params.status === "blocked" || params.status === "failed" ? params.status : "completed",
        summary: truncateUtf8(redactSecrets(String(params.summary ?? "")), 48 * 1024),
        review: reviewValue && (reviewValue.decision === "approved" || reviewValue.decision === "changes_requested")
          ? { ...reviewValue, summary: truncateUtf8(redactSecrets(reviewValue.summary), 48 * 1024) }
          : undefined,
      };
      return { accepted: true, taskId: task.id };
    }
    if (method === "send") return { messageId: this.send(String(params.to ?? "lead"), String(params.message ?? ""), agent.id) };
    if (method === "git_lock") {
      const operation = String(params.operation ?? "");
      const token = String(params.token ?? "");
      const finalize = run.phase === "finalize";
      if (!canMutate && !finalize) throw new Error("This phase has no Git mutation authority.");
      if (!token) throw new Error("Git lock token is required.");
      if ((operation === "branch" || operation === "push") && task.gitAuthority !== "full") {
        throw new Error(`${operation} requires full Git authority.`);
      }
      if ((operation === "commit" || operation === "stage") && task.gitAuthority === "none") {
        throw new Error(`${operation} requires commit or full Git authority.`);
      }
      if (operation === "branch" && !task.paths.includes(".")) {
        throw new Error("Branch-changing Git requires the whole-repository lease '.'.");
      }
      if ((operation === "branch" || operation === "push") && task.autoReview && !finalize) {
        throw new Error(`${operation} is deferred until automatic review is approved.`);
      }
      if (finalize) {
        const hash = await this.diffHash(task);
        if (!task.approvedDiffHash || hash !== task.approvedDiffHash) {
          task.approvedDiffHash = undefined;
          task.phase = "review";
          task.status = "reviewing";
          this.persist();
          this.schedule();
          throw new Error("Reviewed diff changed before finalize; task returned to review.");
        }
      }
      if (operation === "commit") {
        if (task.baseline && (task.baseline.dirtyDiff.trim() || Object.keys(task.baseline.untracked).length)) {
          throw new Error("Task commit is blocked because leased paths contained pre-existing dirty or untracked work.");
        }
        const staged = await this.pi.exec("git", ["-C", this.current.repoRoot, "diff", "--cached", "--name-only", "-z"], { timeout: 5_000 });
        const outside = staged.stdout.split("\0").filter(Boolean).find((path) => !pathCovered(path.replaceAll("\\", "/"), task.paths));
        if (outside) throw new Error(`Unrelated staged path blocks task commit: ${outside}`);
      }
      await this.acquireGit(token, agent.id, run);
      this.persist();
      return { acquired: true, token };
    }
    if (method === "git_unlock") {
      this.releaseGit(String(params.token ?? ""));
      return { released: true };
    }
    if (method === "drift") {
      const paths = Array.isArray(params.paths) ? params.paths.map(String) : [];
      task.status = "paused";
      task.error = `Shell changed paths outside the lease: ${paths.join(", ")}`;
      agent.status = "paused";
      this.action("drift", agent.id, task.id, task.error, true);
      this.persist();
      this.wakeLead(`Task ${task.id} paused after outside-lease shell drift. No changes were reverted.`);
      return { paused: true };
    }
    throw new Error(`Unknown child collaboration method: ${method}`);
  }

  private async settleRun(run: ActiveRun): Promise<void> {
    if (run.ended) return;
    if ((run.stopReason === "error" || run.stopReason === "aborted" || run.lastError) && !run.completion) {
      this.handleRunFailure(run, run.lastError ?? `Child stopped with ${run.stopReason}.`);
      return;
    }
    const task = this.findTask(run.taskId);
    if (!task) return this.finishRun(run);
    if (!run.completion) {
      this.handleRunFailure(run, "Child settled without required team_complete.");
      return;
    }
    await this.applyCompletion(run, run.completion);
    this.finishRun(run);
    this.persist();
    this.schedule();
  }

  private async applyCompletion(run: ActiveRun, completion: Completion): Promise<void> {
    const task = this.findTask(run.taskId);
    const agent = this.findAgent(run.agentId);
    if (!task || !agent) return;
    task.output = completion.summary;
    agent.lastOutput = completion.summary;
    if (completion.status !== "completed") {
      task.status = "blocked";
      task.error = completion.summary;
      task.finishedAt = now();
      agent.status = "paused";
      this.wakeLead(`Task ${task.id} ${completion.status}: ${completion.summary}`);
      return;
    }
    if (run.phase === "review") {
      if (!completion.review) {
        this.failTask(task, "Reviewer did not return structured approved/changes_requested output.");
        return;
      }
      const hash = await this.diffHash(task);
      const guard = reviewLoopGuard(task, completion.review, hash);
      if (guard.stop) {
        this.failTask(task, guard.reason ?? "Review loop guard stopped the task.");
        return;
      }
      task.review = { ...completion.review, fingerprint: guard.fingerprint };
      if (completion.review.decision === "changes_requested") {
        task.reviewFingerprints.push(guard.fingerprint);
        task.preFixDiffHash = hash;
        task.phase = "fix";
        task.status = "queued";
        return;
      }
      task.approvedDiffHash = hash;
      if (task.gitAuthority !== "none") {
        task.phase = "finalize";
        task.status = "queued";
      } else {
        this.completeTask(task);
      }
      return;
    }
    if (run.phase === "finalize" && task.autoReview) {
      const hash = await this.diffHash(task);
      if (!task.approvedDiffHash || hash !== task.approvedDiffHash) {
        task.approvedDiffHash = undefined;
        task.phase = "review";
        task.status = "reviewing";
        return;
      }
    }
    if ((run.phase === "implement" || run.phase === "fix") && task.mutating && task.autoReview) {
      const hash = await this.diffHash(task);
      if (run.phase === "fix" && task.preFixDiffHash === hash) {
        this.failTask(task, "Review requested changes but the fix produced an unchanged diff.");
        return;
      }
      const diff = await this.diffText(task);
      task.reviewSnapshot = {
        prompt: truncateUtf8(redactSecrets(task.prompt), 24 * 1024),
        paths: task.paths,
        baseDiffHash: hash,
        baselineDiff: truncateUtf8(redactSecrets(task.baseline?.dirtyDiff ?? ""), 24 * 1024),
        diff: truncateUtf8(redactSecrets(diff), 48 * 1024),
        implementationSummary: completion.summary,
        createdAt: now(),
      };
      task.approvedDiffHash = undefined;
      task.phase = "review";
      task.status = "reviewing";
      return;
    }
    this.completeTask(task);
  }

  private completeTask(task: TaskRecord): void {
    task.status = "completed";
    task.finishedAt = now();
    this.current.leases = releaseLease(this.current.leases, task.id);
    const owner = task.agentId ? this.findAgent(task.agentId) : undefined;
    if (owner?.lifetime === "task") owner.status = "stopped";
  }

  private failTask(task: TaskRecord, reason: string): void {
    task.status = "blocked";
    task.error = reason;
    task.finishedAt = now();
    this.action("blocked", task.agentId, task.id, reason, true);
    this.wakeLead(`Task ${task.id} blocked: ${reason}`);
  }

  private handleRunFailure(run: ActiveRun, reason: string): void {
    if (!run || run.ended) return;
    const task = this.findTask(run.taskId);
    const agent = this.findAgent(run.agentId);
    this.finishRun(run);
    if (!task || !agent) return;
    const withinBudget = task.turns < task.maxTurns && !!task.startedAt && Date.now() - Date.parse(task.startedAt) < task.timeoutMs;
    if (task.retries < 1 && withinBudget && isRecoverable(reason)) {
      task.retries++;
      task.status = task.phase === "review" ? "reviewing" : "queued";
      agent.status = "hibernated";
      agent.lastError = reason;
      this.action("retry", agent.id, task.id, reason, true);
    } else {
      agent.status = "failed";
      agent.lastError = reason;
      this.failTask(task, reason);
    }
    this.persist();
    this.schedule();
  }

  private onChildClose(run: ActiveRun, error?: Error): void {
    if (!run || run.ended || !error) return;
    this.handleRunFailure(run, error.message);
  }

  private finishRun(run: ActiveRun): void {
    if (run.ended) return;
    run.ended = true;
    if (run.deadline) clearTimeout(run.deadline);
    this.runs.delete(run.agentId);
    const agent = this.findAgent(run.agentId);
    if (agent?.ephemeral && run.phase === "review") agent.status = "stopped";
    else if (agent && agent.status === "running") agent.status = "hibernated";
    this.cancelGitWaiters(run);
    run.rpc.close();
    this.checkWaits();
  }

  private endRun(agentId: string, reason: string): void {
    const run = this.runs.get(agentId);
    if (!run) return;
    run.ended = true;
    if (run.deadline) clearTimeout(run.deadline);
    this.runs.delete(agentId);
    void run.rpc.abort();
    run.rpc.close();
    this.cancelGitWaiters(run);
    this.action(reason, agentId, run.taskId);
  }

  private runsHasTask(taskId: string): boolean {
    return [...this.runs.values()].some((run) => run.taskId === taskId && !run.ended);
  }

  private async acquireGit(token: string, agentId: string, run: ActiveRun): Promise<void> {
    if (run.ended) throw new Error("Child run ended before Git lock acquisition.");
    if (!this.current.gitOwner) {
      this.current.gitOwner = token;
      this.gitTokens.set(token, run);
      return;
    }
    if (this.current.gitOwner === token) return;
    await new Promise<void>((resolveLock, rejectLock) => {
      const waiter = {} as GitWaiter;
      const timer = setTimeout(() => {
        const index = this.gitWaiters.indexOf(waiter);
        if (index >= 0) this.gitWaiters.splice(index, 1);
        rejectLock(new Error("Git lock wait timed out."));
      }, 10_000);
      timer.unref();
      Object.assign(waiter, { token, agentId, run, resolve: resolveLock, reject: rejectLock, timer });
      this.gitWaiters.push(waiter);
    });
    if (run.ended || this.current.gitOwner !== token) throw new Error("Git lock acquisition was cancelled.");
  }

  private releaseGit(token: string): void {
    if (this.current.gitOwner !== token) return;
    this.current.gitOwner = undefined;
    this.gitTokens.delete(token);
    while (this.gitWaiters.length) {
      const next = this.gitWaiters.shift()!;
      clearTimeout(next.timer);
      if (next.run.ended) {
        next.reject(new Error("Child run ended before Git lock acquisition."));
        continue;
      }
      this.current.gitOwner = next.token;
      this.gitTokens.set(next.token, next.run);
      next.resolve();
      break;
    }
    this.persist();
  }

  private cancelGitWaiters(run: ActiveRun): void {
    for (let index = this.gitWaiters.length - 1; index >= 0; index--) {
      const waiter = this.gitWaiters[index];
      if (waiter.run !== run) continue;
      this.gitWaiters.splice(index, 1);
      clearTimeout(waiter.timer);
      waiter.reject(new Error("Child run ended before Git lock acquisition."));
    }
    for (const [token, owner] of [...this.gitTokens]) {
      if (owner === run) this.releaseGit(token);
    }
  }

  private async refreshDirty(): Promise<void> {
    const result = await this.pi.exec("git", ["-C", this.current.repoRoot, "status", "--porcelain=v1", "-z", "--untracked-files=all"], { timeout: 5_000 });
    this.dirtyPaths = result.code === 0 ? parseGitStatusZ(result.stdout) : [];
  }

  private async gitSummary(): Promise<string> {
    const status = await this.pi.exec("git", ["-C", this.current.repoRoot, "status", "--short", "--branch"], { timeout: 5_000 });
    const stat = await this.pi.exec("git", ["-C", this.current.repoRoot, "diff", "--stat", "HEAD", "--"], { timeout: 5_000 });
    return truncateUtf8([status.stdout.trim(), stat.stdout.trim()].filter(Boolean).join("\n"), 8 * 1024);
  }

  private async captureBaseline(task: TaskRecord) {
    const headResult = await this.pi.exec("git", ["-C", this.current.repoRoot, "rev-parse", "HEAD"], { timeout: 5_000 });
    const head = headResult.code === 0 ? headResult.stdout.trim() : "HEAD";
    const dirty = await this.pi.exec("git", ["-C", this.current.repoRoot, "diff", "--binary", head, "--", ...task.paths], { timeout: 10_000 });
    const untracked = await this.untrackedFiles(task.paths);
    const captured: Record<string, string> = {};
    let total = 0;
    for (const path of untracked) {
      const absolute = join(this.current.repoRoot, path);
      if (!existsSync(absolute)) continue;
      const content = readFileSync(absolute);
      const hash = createHash("sha256").update(content).digest("hex");
      if (content.length <= SNAPSHOT_FILE_LIMIT && total + content.length <= SNAPSHOT_TOTAL_LIMIT) {
        captured[path] = `base64:${content.toString("base64")}`;
        total += content.length;
      } else {
        captured[path] = `sha256:${hash}:${content.length}`;
      }
    }
    return { head, dirtyDiff: dirty.stdout, untracked: captured, capturedAt: now() };
  }

  private async untrackedFiles(paths: readonly string[]): Promise<string[]> {
    const result = await this.pi.exec("git", ["-C", this.current.repoRoot, "ls-files", "--others", "--exclude-standard", "-z", "--", ...paths], { timeout: 5_000 });
    return result.code === 0 ? result.stdout.split("\0").filter(Boolean).map((path) => path.replaceAll("\\", "/")) : [];
  }

  private async diffText(task: TaskRecord): Promise<string> {
    const base = task.baseline?.head ?? "HEAD";
    const tracked = await this.pi.exec("git", ["-C", this.current.repoRoot, "diff", "--binary", base, "--", ...task.paths], { timeout: 10_000 });
    const sections = [tracked.stdout];
    for (const path of await this.untrackedFiles(task.paths)) {
      const absolute = join(this.current.repoRoot, path);
      if (!existsSync(absolute)) continue;
      const content = readFileSync(absolute);
      const hash = createHash("sha256").update(content).digest("hex");
      const baseline = task.baseline?.untracked[path];
      if (baseline?.startsWith("base64:") && createHash("sha256").update(Buffer.from(baseline.slice(7), "base64")).digest("hex") === hash) continue;
      if (baseline?.startsWith("sha256:") && baseline.split(":")[1] === hash) continue;
      if (content.includes(0) || content.length > SNAPSHOT_FILE_LIMIT) {
        sections.push(`\nBinary/unbounded untracked file ${path} (${content.length} bytes, sha256 ${hash})\n`);
      } else {
        const before = baseline?.startsWith("base64:") ? Buffer.from(baseline.slice(7), "base64").toString("utf8") : "";
        sections.push(`\n--- a/${path}\n+++ b/${path}\n@@ untracked file @@\n${before ? `# baseline\n${before}\n# current\n` : ""}${content.toString("utf8")}\n`);
      }
    }
    return sections.join("");
  }

  private async diffHash(task: TaskRecord): Promise<string> {
    return createHash("sha256").update(await this.diffText(task)).digest("hex");
  }

  private findAgent(id: string): AgentRecord | undefined {
    return this.current.agents.find((agent) => agent.id === id || agent.name === id);
  }

  private findTask(id: string): TaskRecord | undefined {
    return this.current.tasks.find((task) => task.id === id);
  }

  private action(action: string, agentId?: string, taskId?: string, output?: string, isError = false): void {
    if (!this.state) return;
    const record: ActionRecord = {
      id: randomUUID(),
      at: now(),
      agentId,
      taskId,
      action,
      output: output ? truncateUtf8(redactSecrets(output), OUTPUT_LIMIT) : undefined,
      isError,
    };
    this.current.actions.push(record);
    this.current.actions = this.current.actions.slice(-ACTION_LIMIT);
    this.pi.appendEntry("pi-agents-action", record);
  }

  private wakeLead(message: string): void {
    this.pi.sendMessage({
      customType: "pi-agents",
      content: truncateUtf8(redactSecrets(message), OUTPUT_LIMIT),
      display: true,
    }, { deliverAs: "followUp", triggerTurn: true });
  }

  private persist(): void {
    if (!this.state || !this.path) return;
    if (this.state.tasks.length === 0) {
      this.publish();
      this.checkWaits();
      return;
    }
    this.state.updatedAt = now();
    this.state = markTerminal(this.state);
    if (!allTasksTerminal(this.state)) this.state.finalNotifiedAt = undefined;
    writeStateAtomic(this.path, this.state);
    if (allTasksTerminal(this.state) && !this.state.finalNotifiedAt) {
      this.state.finalNotifiedAt = now();
      writeStateAtomic(this.path, this.state);
      this.wakeLead(`All delegated tasks are final. ${JSON.stringify(privacySnapshot(this.state).tasks)}`);
    }
    this.publish();
    this.checkWaits();
  }

  private publish(): void {
    if (!this.state || !this.ctx) return;
    const snapshot = privacySnapshot(this.state);
    this.pi.events.emit("pi-agents:snapshot", snapshot);
    const lines = panelSummary(this.state);
    this.ctx.ui.setWidget("pi-agents", lines.length ? lines : undefined);
  }

  async dashboard(ctx: ExtensionContext): Promise<void> {
    if (ctx.mode !== "tui") {
      ctx.ui.notify(JSON.stringify(privacySnapshot(this.current)), "info");
      return;
    }
    const selection = await ctx.ui.custom<{ target: string; action: DashboardAction } | null>(
      (tui, _theme, _keybindings, done) => {
        let timer: NodeJS.Timeout | undefined;
        const finish = (value: { target: string; action: DashboardAction } | null) => {
          if (timer) clearInterval(timer);
          done(value);
        };
        const dashboard = new AgentsDashboard(this.current, finish);
        timer = setInterval(() => tui.requestRender(), 500);
        timer.unref();
        return {
          render: (width) => dashboard.render(width),
          invalidate: () => dashboard.invalidate(),
          handleInput: (data) => { dashboard.handleInput(data); tui.requestRender(); },
        };
      },
      { overlay: true, overlayOptions: { width: "85%", maxHeight: "80%", anchor: "center", margin: 1 } },
    );
    if (!selection) return;
    await this.dashboardAction(selection.target, selection.action, ctx);
  }

  private async dashboardAction(agentId: string, action: DashboardAction, ctx: ExtensionContext): Promise<void> {
    if (action === "message") {
      const message = await ctx.ui.input(`Message ${agentId}`, "Plain-text team message");
      if (message) this.send(agentId, message);
      return;
    }
    if (action === "reconfigure") {
      const model = await ctx.ui.input(`Reconfigure ${agentId}`, "model query (blank keeps current)");
      const thinking = await ctx.ui.select("Thinking level", ["keep", "off", "minimal", "low", "medium", "high", "xhigh", "max"]);
      await this.manage({ action, target: agentId, model: model || undefined, thinking: thinking === "keep" ? undefined : thinking });
      return;
    }
    await this.manage({ action, target: agentId });
  }

  shutdown(ctx: ExtensionContext): void {
    this.shuttingDown = true;
    for (const run of [...this.runs.values()]) {
      const task = this.findTask(run.taskId);
      const agent = this.findAgent(run.agentId);
      if (task && !isTaskTerminal(task.status)) task.status = "paused";
      if (agent && agent.status === "running") agent.status = "paused";
      this.endRun(run.agentId, "shutdown");
    }
    this.current.gitOwner = undefined;
    ctx.ui.setWidget("pi-agents", undefined);
    this.persist();
    this.ctx = undefined;
  }
}
