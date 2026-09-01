export const STATE_VERSION = 1;
export const MAX_AGENTS = 16;
export const MAX_TASKS = 64;
export const MAX_ACTIVE_TURNS = 4;
export const MAX_TASK_TURNS = 50;
export const MAX_TASK_MS = 60 * 60 * 1000;
export const TERMINAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export type AgentKind = "explorer" | "implementer" | "reviewer" | "general";
export type AgentStatus =
  | "queued"
  | "running"
  | "idle"
  | "hibernated"
  | "paused"
  | "failed"
  | "stopped";
export type TaskStatus =
  | "queued"
  | "waiting"
  | "running"
  | "reviewing"
  | "fixing"
  | "finalizing"
  | "paused"
  | "blocked"
  | "completed"
  | "failed"
  | "stopped";
export type ContextMode = "bounded" | "fresh" | "full";
export type GitAuthority = "none" | "commit" | "full";
export type ReviewDecision = "approved" | "changes_requested";

export interface ModelRef {
  provider: string;
  id: string;
  name?: string;
  thinkingLevels?: string[];
}

export interface AgentRecord {
  id: string;
  name: string;
  kind: AgentKind;
  model: ModelRef;
  thinking: string;
  instructions: string;
  lifetime: "team" | "task";
  tools?: string[];
  status: AgentStatus;
  taskId?: string;
  sessionFile?: string;
  ephemeral?: boolean;
  createdAt: string;
  updatedAt: string;
  lastOutput?: string;
  lastError?: string;
}

export interface ReviewResult {
  decision: ReviewDecision;
  summary: string;
  fingerprint?: string;
}

export interface ReviewSnapshot {
  prompt: string;
  paths: string[];
  baseDiffHash: string;
  baselineDiff: string;
  diff: string;
  implementationSummary: string;
  createdAt: string;
}

export interface TaskBaseline {
  head: string;
  dirtyDiff: string;
  untracked: Record<string, string>;
  capturedAt: string;
}

export interface TaskRecord {
  id: string;
  title: string;
  prompt: string;
  kind: AgentKind;
  agentId?: string;
  dependsOn: string[];
  paths: string[];
  allowDirty: boolean;
  mutating: boolean;
  autoReview: boolean;
  contextMode: ContextMode;
  gitAuthority: GitAuthority;
  status: TaskStatus;
  phase: "implement" | "review" | "fix" | "finalize";
  attempts: number;
  retries: number;
  turns: number;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  output?: string;
  error?: string;
  review?: ReviewResult;
  reviewSnapshot?: ReviewSnapshot;
  baseline?: TaskBaseline;
  approvedDiffHash?: string;
  reviewFingerprints: string[];
  preFixDiffHash?: string;
  reviewAgentId?: string;
  maxTurns: number;
  timeoutMs: number;
}

export interface LeaseRecord {
  taskId: string;
  agentId: string;
  paths: string[];
  acquiredAt: string;
}

export interface MailMessage {
  id: string;
  from: string;
  to: string;
  text: string;
  createdAt: string;
  readAt?: string;
}

export interface ActionRecord {
  id: string;
  at: string;
  agentId?: string;
  taskId?: string;
  action: string;
  output?: string;
  isError?: boolean;
}

export interface TeamState {
  version: typeof STATE_VERSION;
  parentSessionId: string;
  cwd: string;
  repoRoot: string;
  createdAt: string;
  updatedAt: string;
  terminalAt?: string;
  agents: AgentRecord[];
  tasks: TaskRecord[];
  leases: LeaseRecord[];
  mailboxes: Record<string, MailMessage[]>;
  actions: ActionRecord[];
  maxConcurrent: number;
  gitOwner?: string;
  finalNotifiedAt?: string;
}

export interface AgentInput {
  id?: string;
  name: string;
  kind: AgentKind;
  model?: string;
  thinking?: string;
  instructions?: string;
  lifetime?: "team" | "task";
  tools?: string[];
}

export interface TaskInput {
  id?: string;
  title?: string;
  prompt: string;
  kind?: AgentKind;
  agent?: string;
  dependsOn?: string[];
  paths?: string[];
  allowDirty?: boolean;
  mutating?: boolean;
  autoReview?: boolean;
  context?: ContextMode;
  gitAuthority?: GitAuthority;
  maxTurns?: number;
  timeoutMinutes?: number;
}

export interface PrivacySnapshot {
  version: 1;
  active: number;
  queued: number;
  blocked: number;
  agents: Array<{
    id: string;
    name: string;
    kind: AgentKind;
    status: AgentStatus;
    taskId?: string;
    model: ModelRef;
  }>;
  tasks: Array<{
    id: string;
    title: string;
    status: TaskStatus;
    agentId?: string;
    dependsOn: string[];
  }>;
}

export function isTaskTerminal(status: TaskStatus): boolean {
  return status === "completed" || status === "failed" || status === "stopped";
}

export function isAgentTerminal(status: AgentStatus): boolean {
  return status === "failed" || status === "stopped";
}
