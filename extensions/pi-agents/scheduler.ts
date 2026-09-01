import { createHash, randomUUID } from "node:crypto";
import {
  MAX_ACTIVE_TURNS,
  MAX_AGENTS,
  MAX_TASK_MS,
  MAX_TASK_TURNS,
  MAX_TASKS,
  STATE_VERSION,
  type AgentInput,
  type AgentKind,
  type AgentRecord,
  type ModelRef,
  type ReviewResult,
  type TaskInput,
  type TaskRecord,
  type TeamState,
  isTaskTerminal,
} from "./types.ts";

const KINDS = new Set<AgentKind>(["explorer", "implementer", "reviewer", "general"]);
const THINKING = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const REVIEWED_AGENT_TOOLS = new Set([
  "read", "bash", "grep", "find", "ls", "edit", "write",
  "web_search", "source_check", "fetch_content", "get_search_content",
]);

export function safeId(value: string, prefix: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return (normalized || `${prefix}-${randomUUID().slice(0, 8)}`).slice(0, 64);
}

export function resolveModelQuery(
  query: string | undefined,
  models: readonly ModelRef[],
  parent: ModelRef | undefined,
): ModelRef {
  if (!query?.trim()) {
    if (!parent) throw new Error("The parent session has no active model.");
    return { ...parent };
  }
  const needle = query.trim().toLowerCase();
  const exact = models.filter((model) =>
    `${model.provider}/${model.id}`.toLowerCase() === needle
    || model.id.toLowerCase() === needle
    || model.name?.toLowerCase() === needle,
  );
  if (exact.length === 1) return { ...exact[0] };
  if (exact.length > 1) {
    throw new Error(`Model query is ambiguous: ${query} (${exact.map(modelLabel).join(", ")})`);
  }
  const partial = models.filter((model) =>
    `${model.provider}/${model.id} ${model.name ?? ""}`.toLowerCase().includes(needle),
  );
  if (partial.length === 1) return { ...partial[0] };
  if (partial.length > 1) {
    throw new Error(`Model query is not unique: ${query} (${partial.slice(0, 8).map(modelLabel).join(", ")})`);
  }
  throw new Error(`Model not found: ${query}. No fallback was used.`);
}

function modelLabel(model: ModelRef): string {
  return `${model.provider}/${model.id}`;
}

export function validateDag(tasks: readonly Pick<TaskRecord, "id" | "dependsOn">[]): void {
  const ids = new Set(tasks.map((task) => task.id));
  if (ids.size !== tasks.length) throw new Error("Task IDs must be unique.");
  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!ids.has(dependency)) throw new Error(`Task ${task.id} has unknown dependency ${dependency}.`);
      if (dependency === task.id) throw new Error(`Task ${task.id} cannot depend on itself.`);
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const visit = (id: string) => {
    if (visiting.has(id)) throw new Error(`Task dependency cycle includes ${id}.`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of ids) visit(id);
}

export function roleMatches(agent: Pick<AgentRecord, "kind">, task: Pick<TaskRecord, "kind" | "mutating">): boolean {
  if (agent.kind === "general") return true;
  if (task.kind === "general") return agent.kind === (task.mutating ? "implementer" : "explorer");
  return agent.kind === task.kind;
}

export function dependenciesReady(task: TaskRecord, tasks: readonly TaskRecord[]): boolean {
  const byId = new Map(tasks.map((candidate) => [candidate.id, candidate]));
  return task.dependsOn.every((id) => byId.get(id)?.status === "completed");
}

export function dependencyFailure(task: TaskRecord, tasks: readonly TaskRecord[]): string | undefined {
  const byId = new Map(tasks.map((candidate) => [candidate.id, candidate]));
  const failed = task.dependsOn.find((id) => {
    const status = byId.get(id)?.status;
    return status === "failed" || status === "stopped" || status === "blocked";
  });
  return failed ? `Dependency ${failed} did not complete.` : undefined;
}

export interface BuildPlanOptions {
  state: TeamState;
  agents: AgentInput[];
  tasks: TaskInput[];
  models: readonly ModelRef[];
  parentModel?: ModelRef;
  parentThinking: string;
  now?: string;
  defaultAuthority?: "none" | "commit" | "full";
}

/** Build and validate a complete plan before callers mutate persistent state. */
export function buildAtomicPlan(options: BuildPlanOptions): { agents: AgentRecord[]; tasks: TaskRecord[] } {
  if (!options.tasks.length) throw new Error("tasks[] must be non-empty.");
  if (!options.agents.length && !options.state.agents.length) throw new Error("At least one agent is required.");
  if (options.state.agents.length + options.agents.length > MAX_AGENTS) throw new Error(`Agent cap is ${MAX_AGENTS}.`);
  if (options.state.tasks.length + options.tasks.length > MAX_TASKS) throw new Error(`Task cap is ${MAX_TASKS}.`);
  const now = options.now ?? new Date().toISOString();
  const existingAgentIds = new Set(options.state.agents.flatMap((agent) => [agent.id, agent.name]));
  const agents = options.agents.map((input, index): AgentRecord => {
    if (!KINDS.has(input.kind)) throw new Error(`Invalid agent kind: ${input.kind}`);
    const id = safeId(input.id ?? input.name ?? `agent-${index + 1}`, "agent");
    if (existingAgentIds.has(id) || existingAgentIds.has(input.name)) throw new Error(`Duplicate agent: ${id}`);
    existingAgentIds.add(id);
    existingAgentIds.add(input.name);
    const requestedThinking = input.thinking ?? options.parentThinking;
    if (!THINKING.has(requestedThinking)) throw new Error(`Invalid thinking level for ${id}: ${requestedThinking}`);
    const model = resolveModelQuery(input.model, options.models, options.parentModel);
    const orderedThinking = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
    const supported = model.thinkingLevels?.length ? model.thinkingLevels : orderedThinking;
    let thinking = requestedThinking;
    if (!supported.includes(thinking)) {
      const requestedIndex = orderedThinking.indexOf(thinking);
      thinking = orderedThinking.slice(0, requestedIndex + 1).toReversed().find((level) => supported.includes(level))
        ?? supported[0]
        ?? "off";
    }
    const invalidTool = input.tools?.find((tool) => !REVIEWED_AGENT_TOOLS.has(tool));
    if (invalidTool) throw new Error(`Unreviewed child tool requested for ${id}: ${invalidTool}`);
    return {
      id,
      name: input.name.trim() || id,
      kind: input.kind,
      model,
      thinking,
      instructions: input.instructions?.trim() ?? "",
      lifetime: input.lifetime ?? "team",
      tools: input.tools ? [...new Set(input.tools)] : undefined,
      status: "queued",
      createdAt: now,
      updatedAt: now,
    };
  });
  const allAgents = [...options.state.agents, ...agents];
  const agentByName = new Map(allAgents.flatMap((agent) => [[agent.id, agent], [agent.name, agent]]));
  const existingTaskIds = new Set(options.state.tasks.map((task) => task.id));
  const tasks = options.tasks.map((input, index): TaskRecord => {
    const id = safeId(input.id ?? input.title ?? `task-${options.state.tasks.length + index + 1}`, "task");
    if (existingTaskIds.has(id)) throw new Error(`Duplicate task: ${id}`);
    existingTaskIds.add(id);
    if (!input.prompt.trim()) throw new Error(`Task ${id} has an empty prompt.`);
    const agent = input.agent ? agentByName.get(input.agent) : undefined;
    if (input.agent && !agent) throw new Error(`Task ${id} references unknown agent ${input.agent}.`);
    const kind = input.kind ?? agent?.kind ?? (input.mutating ? "implementer" : "explorer");
    if (!KINDS.has(kind)) throw new Error(`Invalid task kind: ${kind}`);
    const task: TaskRecord = {
      id,
      title: input.title?.trim() || input.prompt.trim().split("\n", 1)[0].slice(0, 100),
      prompt: input.prompt.trim(),
      kind,
      agentId: agent?.id,
      dependsOn: [...new Set(input.dependsOn ?? [])].map((dependency) => safeId(dependency, "task")),
      paths: [...new Set(input.paths?.length ? input.paths : (input.mutating ?? kind === "implementer") ? ["."] : [])],
      allowDirty: input.allowDirty ?? false,
      mutating: input.mutating ?? kind === "implementer",
      autoReview: input.autoReview ?? (input.mutating ?? kind === "implementer"),
      contextMode: input.context ?? "bounded",
      gitAuthority: input.gitAuthority ?? options.defaultAuthority ?? "none",
      status: "queued",
      phase: "implement",
      attempts: 0,
      retries: 0,
      turns: 0,
      createdAt: now,
      updatedAt: now,
      reviewFingerprints: [],
      maxTurns: input.maxTurns ?? MAX_TASK_TURNS,
      timeoutMs: (input.timeoutMinutes ?? MAX_TASK_MS / 60_000) * 60_000,
    };
    if (!Number.isInteger(task.maxTurns) || task.maxTurns < 1 || task.maxTurns > 500) {
      throw new Error(`Task ${id} maxTurns must be an integer from 1 to 500.`);
    }
    if (!Number.isFinite(task.timeoutMs) || task.timeoutMs < 60_000 || task.timeoutMs > 24 * 60 * 60 * 1000) {
      throw new Error(`Task ${id} timeoutMinutes must be from 1 to 1440.`);
    }
    if (agent && !roleMatches(agent, task)) {
      throw new Error(`Agent ${agent.name} (${agent.kind}) does not match task ${id} (${kind}).`);
    }
    return task;
  });
  validateDag([...options.state.tasks, ...tasks]);
  for (const task of tasks) {
    if (!task.agentId && !allAgents.some((agent) => roleMatches(agent, task))) {
      throw new Error(`Task ${task.id} has no compatible ${task.kind} agent.`);
    }
  }
  return { agents, tasks };
}

export function createEmptyState(parentSessionId: string, cwd: string, repoRoot: string, now = new Date().toISOString()): TeamState {
  return {
    version: STATE_VERSION,
    parentSessionId,
    cwd,
    repoRoot,
    createdAt: now,
    updatedAt: now,
    agents: [],
    tasks: [],
    leases: [],
    mailboxes: {},
    actions: [],
    maxConcurrent: MAX_ACTIVE_TURNS,
  };
}

export function reviewFingerprint(summary: string): string {
  const normalized = summary.toLowerCase().replace(/\bline\s+\d+\b/g, "line").replace(/\d+/g, "#").replace(/\s+/g, " ").trim();
  return createHash("sha256").update(normalized).digest("hex").slice(0, 20);
}

export function reviewLoopGuard(
  task: TaskRecord,
  review: ReviewResult,
  currentDiffHash: string,
): { stop: boolean; reason?: string; fingerprint: string } {
  const fingerprint = reviewFingerprint(review.summary);
  if (review.decision === "approved") return { stop: false, fingerprint };
  if (task.preFixDiffHash && task.preFixDiffHash === currentDiffHash) {
    return { stop: true, reason: "Review requested changes but the fix produced an unchanged diff.", fingerprint };
  }
  if (task.reviewFingerprints.includes(fingerprint)) {
    return { stop: true, reason: "A material review finding repeated after a fix cycle.", fingerprint };
  }
  return { stop: false, fingerprint };
}

export function allTasksTerminal(state: TeamState): boolean {
  return state.tasks.length > 0 && state.tasks.every((task) => isTaskTerminal(task.status));
}
