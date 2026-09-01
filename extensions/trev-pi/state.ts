import { sanitizeTerminalText } from "@narumitw/pi-tui-kit/terminal-text";

export type LoadState<T> =
  | { kind: "loading"; value?: T; updatedAt?: number }
  | { kind: "ready"; value: T; updatedAt: number }
  | { kind: "empty"; reason: string; updatedAt: number }
  | { kind: "error"; message: string; updatedAt: number; value?: T };

export interface GitTelemetry {
  branch: string;
  oid?: string;
  upstream?: string;
  ahead: number;
  behind: number;
  staged: number;
  unstaged: number;
  untracked: number;
  conflicted: number;
  changed: number;
}

export interface PullRequestTelemetry {
  number: number;
  isDraft: boolean;
  url: string;
  state: string;
  closedAt?: string;
  mergedAt?: string;
  reviewDecision: string;
  checks: {
    total: number;
    success: number;
    pending: number;
    failure: number;
    neutral: number;
  };
}

export interface CollectorHealth {
  id: "git" | "pull-request" | "notifications";
  command: string;
  refresh: string;
  requests: number;
  runs: number;
  coalesced: number;
  inFlight: boolean;
  queued: boolean;
  lastAttemptAt?: number;
  lastSuccessAt?: number;
  failure?: string;
}

export interface TelemetrySnapshot {
  git: LoadState<GitTelemetry>;
  pullRequest: LoadState<PullRequestTelemetry>;
  notifications: LoadState<number>;
  health: Record<CollectorHealth["id"], CollectorHealth>;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
  killed?: boolean;
}

export type Exec = (
  command: string,
  args: string[],
  options: { cwd?: string; timeout?: number; signal?: AbortSignal },
) => Promise<ExecResult>;

const GIT_COMMAND = "git status --porcelain=v2 --branch";
const PR_FIELDS = "number,isDraft,url,state,closedAt,mergedAt,reviewDecision,statusCheckRollup";
const PR_COMMAND = `gh pr view --json ${PR_FIELDS}`;
const NOTIFICATIONS_COMMAND = "gh api notifications --paginate --cache 5m --jq length";
const MAX_GIT_OUTPUT_BYTES = 1024 * 1024;
const MAX_PR_OUTPUT_BYTES = 256 * 1024;
const MAX_NOTIFICATION_OUTPUT_BYTES = 64 * 1024;

function safeError(result: Partial<ExecResult>, fallback: string): string {
  const raw = result.stderr?.trim() || result.stdout?.trim() || fallback;
  return sanitizeTerminalText(raw.slice(0, 4_096)).replace(/\s+/gu, " ").slice(0, 240) || fallback;
}

function requireBoundedOutput(output: string, maximumBytes: number, label: string): void {
  if (Buffer.byteLength(output, "utf8") > maximumBytes) {
    throw new Error(`${label} output exceeded ${maximumBytes} bytes`);
  }
}

function isConflictCode(code: string): boolean {
  return code === "DD" || code === "AU" || code === "UD" || code === "UA" || code === "DU" || code === "AA" || code === "UU";
}

/** Parse the complete porcelain-v2 branch/status snapshot without invoking Git again. */
export function parseGitStatusV2(output: string): GitTelemetry {
  const value: GitTelemetry = {
    branch: "detached",
    ahead: 0,
    behind: 0,
    staged: 0,
    unstaged: 0,
    untracked: 0,
    conflicted: 0,
    changed: 0,
  };

  for (const rawLine of output.split("\n")) {
    const line = rawLine.replace(/\r$/u, "");
    if (!line) continue;
    if (line.startsWith("# branch.oid ")) {
      const oid = line.slice(13).trim();
      if (oid && oid !== "(initial)") value.oid = oid;
      continue;
    }
    if (line.startsWith("# branch.head ")) {
      const branch = line.slice(14).trim();
      value.branch = branch === "(detached)" ? "detached" : branch || "detached";
      continue;
    }
    if (line.startsWith("# branch.upstream ")) {
      const upstream = line.slice(18).trim();
      if (upstream) value.upstream = upstream;
      continue;
    }
    if (line.startsWith("# branch.ab ")) {
      const match = line.match(/^# branch\.ab \+(\d+) -(\d+)$/u);
      if (match) {
        value.ahead = Number(match[1]);
        value.behind = Number(match[2]);
      }
      continue;
    }
    if (line.startsWith("? ")) {
      value.untracked += 1;
      value.changed += 1;
      continue;
    }
    if (line.startsWith("u ")) {
      value.conflicted += 1;
      value.changed += 1;
      continue;
    }
    if (line.startsWith("1 ") || line.startsWith("2 ")) {
      const code = line.slice(2, 4);
      if (isConflictCode(code)) value.conflicted += 1;
      else {
        if (code[0] !== ".") value.staged += 1;
        if (code[1] !== ".") value.unstaged += 1;
      }
      value.changed += 1;
    }
  }
  return value;
}

function checkState(check: Record<string, unknown>): "success" | "pending" | "failure" | "neutral" {
  const status = String(check.status ?? check.state ?? "").toUpperCase();
  const conclusion = String(check.conclusion ?? check.state ?? "").toUpperCase();
  if (["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE"].includes(conclusion)) {
    return "failure";
  }
  if (["PENDING", "EXPECTED", "QUEUED", "IN_PROGRESS", "WAITING", "REQUESTED"].includes(status) || !conclusion) {
    return "pending";
  }
  if (conclusion === "SUCCESS") return "success";
  return "neutral";
}

export function parsePullRequest(output: string): PullRequestTelemetry {
  const raw = JSON.parse(output) as Record<string, unknown>;
  if (!Number.isInteger(raw.number) || Number(raw.number) <= 0) throw new Error("Invalid pull request number");
  const rollup = Array.isArray(raw.statusCheckRollup) ? raw.statusCheckRollup : [];
  const checks = { total: rollup.length, success: 0, pending: 0, failure: 0, neutral: 0 };
  for (const item of rollup) {
    const state = checkState(item && typeof item === "object" ? item as Record<string, unknown> : {});
    checks[state] += 1;
  }
  return {
    number: Number(raw.number),
    isDraft: raw.isDraft === true,
    url: typeof raw.url === "string" ? raw.url : "",
    state: typeof raw.state === "string" ? raw.state : "UNKNOWN",
    ...(typeof raw.closedAt === "string" ? { closedAt: raw.closedAt } : {}),
    ...(typeof raw.mergedAt === "string" ? { mergedAt: raw.mergedAt } : {}),
    reviewDecision: typeof raw.reviewDecision === "string" && raw.reviewDecision ? raw.reviewDecision : "none",
    checks,
  };
}

export function parseGitHubNotificationCount(output: string): number {
  const values = output.trim().split(/\s+/u);
  if (!output.trim() || values.some((value) => !/^\d+$/u.test(value))) {
    throw new Error("Invalid GitHub notification count");
  }
  const count = values.reduce((total, value) => total + Number(value), 0);
  if (!Number.isSafeInteger(count)) throw new Error("Invalid GitHub notification count");
  return count;
}

/** At most one run plus one coalesced rerun can be owned at a time. */
export class CoalescingJob {
  private running = false;
  private pending = false;
  private disposed = false;
  private current: Promise<void> | undefined;

  constructor(
    private readonly work: () => Promise<void>,
    private readonly changed?: (state: { running: boolean; pending: boolean; coalesced: boolean }) => void,
  ) {}

  request(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.running) {
      this.pending = true;
      this.changed?.({ running: true, pending: true, coalesced: true });
      return this.current ?? Promise.resolve();
    }
    this.running = true;
    this.pending = true;
    this.current = this.drain();
    return this.current;
  }

  dispose(): void {
    this.disposed = true;
    this.pending = false;
    this.changed?.({ running: this.running, pending: false, coalesced: false });
  }

  private async drain(): Promise<void> {
    try {
      while (!this.disposed && this.pending) {
        this.pending = false;
        this.changed?.({ running: true, pending: false, coalesced: false });
        await this.work();
      }
    } finally {
      this.running = false;
      this.current = undefined;
      this.changed?.({ running: false, pending: false, coalesced: false });
    }
  }
}

interface CollectorOptions {
  exec: Exec;
  cwd: string;
  signal: AbortSignal;
  isCurrent: () => boolean;
  onChange: () => void;
  now?: () => number;
  setInterval?: (callback: () => void, delay: number) => ReturnType<typeof globalThis.setInterval>;
  clearInterval?: (timer: ReturnType<typeof globalThis.setInterval>) => void;
}

function initialHealth(): TelemetrySnapshot["health"] {
  return {
    git: { id: "git", command: GIT_COMMAND, refresh: "startup, Git events, every 30s", requests: 0, runs: 0, coalesced: 0, inFlight: false, queued: false },
    "pull-request": { id: "pull-request", command: PR_COMMAND, refresh: "startup, branch changes, every 60s", requests: 0, runs: 0, coalesced: 0, inFlight: false, queued: false },
    notifications: { id: "notifications", command: NOTIFICATIONS_COMMAND, refresh: "startup, every 5m (gh cache 5m)", requests: 0, runs: 0, coalesced: 0, inFlight: false, queued: false },
  };
}

export class TelemetryCollector {
  private readonly now: () => number;
  private readonly setTimer: NonNullable<CollectorOptions["setInterval"]>;
  private readonly clearTimer: NonNullable<CollectorOptions["clearInterval"]>;
  private readonly timers: Array<ReturnType<typeof globalThis.setInterval>> = [];
  private stopped = false;
  private lastBranch?: string;
  private readonly jobs: Record<CollectorHealth["id"], CoalescingJob>;
  private readonly snapshot: TelemetrySnapshot = {
    git: { kind: "loading" },
    pullRequest: { kind: "loading" },
    notifications: { kind: "loading" },
    health: initialHealth(),
  };

  constructor(private readonly options: CollectorOptions) {
    this.now = options.now ?? Date.now;
    this.setTimer = options.setInterval ?? ((callback, delay) => globalThis.setInterval(callback, delay));
    this.clearTimer = options.clearInterval ?? ((timer) => globalThis.clearInterval(timer));
    this.jobs = {
      git: this.createJob("git", () => this.collectGit()),
      "pull-request": this.createJob("pull-request", () => this.collectPullRequest()),
      notifications: this.createJob("notifications", () => this.collectNotifications()),
    };
  }

  start(): void {
    if (this.stopped || this.timers.length) return;
    void this.refreshGit();
    void this.refreshPullRequest();
    void this.refreshNotifications();
    this.timers.push(
      this.setTimer(() => void this.refreshGit(), 30_000),
      this.setTimer(() => void this.refreshPullRequest(), 60_000),
      this.setTimer(() => void this.refreshNotifications(), 5 * 60_000),
    );
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const timer of this.timers.splice(0)) this.clearTimer(timer);
    for (const job of Object.values(this.jobs)) job.dispose();
  }

  get(): Readonly<TelemetrySnapshot> {
    return this.snapshot;
  }

  refreshGit(): Promise<void> {
    return this.request("git");
  }

  refreshPullRequest(): Promise<void> {
    return this.request("pull-request");
  }

  refreshNotifications(): Promise<void> {
    return this.request("notifications");
  }

  private request(id: CollectorHealth["id"]): Promise<void> {
    if (this.stopped || this.options.signal.aborted || !this.options.isCurrent()) return Promise.resolve();
    this.snapshot.health[id].requests += 1;
    return this.jobs[id].request();
  }

  private createJob(id: CollectorHealth["id"], work: () => Promise<void>): CoalescingJob {
    return new CoalescingJob(async () => {
      const health = this.snapshot.health[id];
      health.runs += 1;
      health.lastAttemptAt = this.now();
      health.inFlight = true;
      this.options.onChange();
      await work();
    }, ({ running, pending, coalesced }) => {
      const health = this.snapshot.health[id];
      health.inFlight = running;
      health.queued = pending;
      if (coalesced) health.coalesced += 1;
      this.options.onChange();
    });
  }

  private canPublish(): boolean {
    return !this.stopped && !this.options.signal.aborted && this.options.isCurrent();
  }

  private succeeded(id: CollectorHealth["id"]): void {
    const health = this.snapshot.health[id];
    health.lastSuccessAt = this.now();
    delete health.failure;
  }

  private failed(id: CollectorHealth["id"], message: string): void {
    this.snapshot.health[id].failure = message;
  }

  private async collectGit(): Promise<void> {
    let result: ExecResult;
    try {
      result = await this.options.exec("git", ["status", "--porcelain=v2", "--branch"], {
        cwd: this.options.cwd,
        timeout: 5_000,
        signal: this.options.signal,
      });
    } catch (error) {
      if (!this.canPublish()) return;
      const message = safeError({}, error instanceof Error ? error.message : "Git status failed");
      this.snapshot.git = { kind: "error", message, updatedAt: this.now() };
      this.failed("git", message);
      this.options.onChange();
      return;
    }
    if (!this.canPublish()) return;
    const at = this.now();
    if (result.code !== 0) {
      const message = safeError(result, "Git status failed");
      if (/not a git repository/iu.test(`${result.stderr}\n${result.stdout}`)) {
        this.snapshot.git = { kind: "empty", reason: "Not a Git repository", updatedAt: at };
        this.succeeded("git");
      } else {
        this.snapshot.git = { kind: "error", message, updatedAt: at };
        this.failed("git", message);
      }
      this.options.onChange();
      return;
    }
    try {
      requireBoundedOutput(result.stdout, MAX_GIT_OUTPUT_BYTES, "Git status");
      const value = parseGitStatusV2(result.stdout);
      const branchChanged = this.lastBranch !== undefined && this.lastBranch !== value.branch;
      this.lastBranch = value.branch;
      this.snapshot.git = { kind: "ready", value, updatedAt: at };
      this.succeeded("git");
      this.options.onChange();
      if (branchChanged) void this.refreshPullRequest();
    } catch (error) {
      const message = safeError({}, error instanceof Error ? error.message : "Invalid Git status");
      this.snapshot.git = { kind: "error", message, updatedAt: at };
      this.failed("git", message);
      this.options.onChange();
    }
  }

  private async collectPullRequest(): Promise<void> {
    let result: ExecResult;
    try {
      result = await this.options.exec("gh", ["pr", "view", "--json", PR_FIELDS], {
        cwd: this.options.cwd,
        timeout: 20_000,
        signal: this.options.signal,
      });
    } catch (error) {
      if (!this.canPublish()) return;
      const message = safeError({}, error instanceof Error ? error.message : "Pull request refresh failed");
      this.snapshot.pullRequest = { kind: "error", message, updatedAt: this.now() };
      this.failed("pull-request", message);
      this.options.onChange();
      return;
    }
    if (!this.canPublish()) return;
    const at = this.now();
    if (result.code !== 0) {
      const combined = `${result.stderr}\n${result.stdout}`;
      if (/no pull requests? found|could not find.*pull request|no pull request found for branch|not a git repository|no git remotes? found/iu.test(combined)) {
        this.snapshot.pullRequest = { kind: "empty", reason: "No pull request for current branch", updatedAt: at };
        this.succeeded("pull-request");
      } else {
        const message = safeError(result, "Pull request refresh failed");
        this.snapshot.pullRequest = { kind: "error", message, updatedAt: at };
        this.failed("pull-request", message);
      }
      this.options.onChange();
      return;
    }
    try {
      requireBoundedOutput(result.stdout, MAX_PR_OUTPUT_BYTES, "Pull request");
      this.snapshot.pullRequest = { kind: "ready", value: parsePullRequest(result.stdout), updatedAt: at };
      this.succeeded("pull-request");
    } catch (error) {
      const message = safeError({}, error instanceof Error ? error.message : "Invalid pull request data");
      this.snapshot.pullRequest = { kind: "error", message, updatedAt: at };
      this.failed("pull-request", message);
    }
    this.options.onChange();
  }

  private async collectNotifications(): Promise<void> {
    let result: ExecResult;
    try {
      result = await this.options.exec("gh", ["api", "notifications", "--paginate", "--cache", "5m", "--jq", "length"], {
        timeout: 30_000,
        signal: this.options.signal,
      });
    } catch (error) {
      if (!this.canPublish()) return;
      const message = safeError({}, error instanceof Error ? error.message : "GitHub notification refresh failed");
      this.snapshot.notifications = { kind: "error", message, updatedAt: this.now() };
      this.failed("notifications", message);
      this.options.onChange();
      return;
    }
    if (!this.canPublish()) return;
    const at = this.now();
    if (result.code !== 0) {
      const message = safeError(result, "GitHub notification refresh failed");
      this.snapshot.notifications = { kind: "error", message, updatedAt: at };
      this.failed("notifications", message);
      this.options.onChange();
      return;
    }
    try {
      requireBoundedOutput(result.stdout, MAX_NOTIFICATION_OUTPUT_BYTES, "GitHub notification");
      this.snapshot.notifications = { kind: "ready", value: parseGitHubNotificationCount(result.stdout), updatedAt: at };
      this.succeeded("notifications");
    } catch (error) {
      const message = safeError({}, error instanceof Error ? error.message : "Invalid GitHub notification count");
      this.snapshot.notifications = { kind: "error", message, updatedAt: at };
      this.failed("notifications", message);
    }
    this.options.onChange();
  }
}
