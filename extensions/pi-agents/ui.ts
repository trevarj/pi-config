import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { AgentRecord, TaskRecord, TeamState } from "./types.ts";

export type DashboardAction = "message" | "pause" | "resume" | "retry" | "reconfigure" | "stop";
export interface DashboardSelection { target: string; action: DashboardAction }

type View = "agents" | "tasks" | "detail";
type UiTheme = Pick<Theme, "fg" | "bg" | "bold">;

const plainTheme: UiTheme = {
  fg: (_color, text) => text,
  bg: (_color, text) => text,
  bold: (text) => text,
};

function isFinalTask(task: TaskRecord): boolean {
  return ["completed", "failed", "stopped"].includes(task.status);
}

function taskForAgent(state: TeamState, agent: AgentRecord): TaskRecord | undefined {
  const assigned = state.tasks.find((task) => task.id === agent.taskId);
  if (assigned && !isFinalTask(assigned)) return assigned;
  return state.tasks.find((task) => (task.agentId === agent.id || task.reviewAgentId === agent.id) && !isFinalTask(task)) ?? assigned;
}

function statusColor(status: AgentRecord["status"] | TaskRecord["status"]): "success" | "warning" | "error" | "muted" {
  if (["running", "reviewing", "fixing", "finalizing", "completed"].includes(status)) return "success";
  if (["queued", "waiting", "paused"].includes(status)) return "warning";
  if (["blocked", "failed"].includes(status)) return "error";
  return "muted";
}

function thinkingColor(level: string): "thinkingOff" | "thinkingMinimal" | "thinkingLow" | "thinkingMedium" | "thinkingHigh" | "thinkingXhigh" | "thinkingMax" {
  const colors = {
    off: "thinkingOff", minimal: "thinkingMinimal", low: "thinkingLow", medium: "thinkingMedium",
    high: "thinkingHigh", xhigh: "thinkingXhigh", max: "thinkingMax",
  } as const;
  return colors[level as keyof typeof colors] ?? "thinkingOff";
}

export function panelSummary(state: TeamState, theme: UiTheme = plainTheme, width = Number.MAX_SAFE_INTEGER): string[] {
  const active = state.agents.filter((agent) => agent.status === "running");
  const queued = state.tasks.filter((task) => task.status === "queued" || task.status === "waiting");
  const blocked = state.tasks.filter((task) => task.status === "blocked" || task.status === "failed");
  const visible = state.agents.filter((agent) => {
    const task = taskForAgent(state, agent);
    return agent.status === "running" || (!!task && !isFinalTask(task));
  });
  if (!active.length && !queued.length && !blocked.length && !visible.length) return [];
  const heading = `${theme.fg("accent", theme.bold("Agents"))}  ${active.length} active · ${queued.length} queued${blocked.length ? ` · ${blocked.length} blocked` : ""}`;
  const lines = [`${heading}  ${theme.fg("dim", "·")} ${theme.fg("accent", "/agents")} ${theme.fg("dim", "opens selectable view")}`];
  for (const agent of visible.slice(0, 3)) {
    const task = taskForAgent(state, agent);
    const status = task?.status ?? agent.status;
    const description = task?.title ?? "idle";
    lines.push([
      theme.fg(statusColor(status), agent.status === "running" ? "●" : "○"),
      theme.bold(agent.name),
      theme.fg("muted", `${agent.model.provider}/${agent.model.id}`),
      theme.fg(thinkingColor(agent.thinking), agent.thinking),
      description,
      theme.fg(statusColor(status), `[${status}${task ? `/${task.phase}` : ""}]`),
    ].join(" · "));
  }
  if (visible.length > 3) lines.push(theme.fg("dim", `  +${visible.length - 3} more in /agents`));
  return lines.map((line) => truncateToWidth(line, Math.max(1, width)));
}

export class AgentsDashboard {
  private selected = 0;
  private view: View = "agents";
  private detail?: { kind: "agent" | "task"; id: string };
  private readonly getState: () => TeamState;
  private readonly done: (value: DashboardSelection | null) => void;
  private readonly theme: UiTheme;

  constructor(state: TeamState | (() => TeamState), done: (value: DashboardSelection | null) => void, theme: UiTheme = plainTheme) {
    this.getState = typeof state === "function" ? state : () => state;
    this.done = done;
    this.theme = theme;
  }

  private get state(): TeamState {
    return this.getState();
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const raw = this.view === "detail" ? this.detailLines() : this.listLines();
    return raw.flatMap((line, index) => index === 1
      ? wrapTextWithAnsi(line, safeWidth)
      : [truncateToWidth(line, safeWidth)]);
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      if (this.view === "detail") {
        this.view = this.detail?.kind === "task" ? "tasks" : "agents";
        this.detail = undefined;
      } else this.done(null);
      return;
    }
    if (matchesKey(data, Key.tab) && this.view !== "detail") {
      this.view = this.view === "agents" ? "tasks" : "agents";
      this.selected = 0;
      return;
    }
    const items = this.items();
    if (matchesKey(data, Key.up)) this.selected = Math.max(0, this.selected - 1);
    else if (matchesKey(data, Key.down)) this.selected = Math.min(Math.max(0, items.length - 1), this.selected + 1);
    else if (matchesKey(data, Key.enter) && this.view !== "detail") {
      const item = items[this.selected];
      if (item) {
        this.detail = { kind: this.view === "tasks" ? "task" : "agent", id: item.id };
        this.view = "detail";
      }
    } else {
      const target = this.actionTarget();
      const key = data.toLowerCase();
      if (!target) return;
      if (key === "m" && this.detail?.kind !== "task") this.done({ target, action: "message" });
      else if (key === "p") this.done({ target, action: "pause" });
      else if (key === "r") this.done({ target, action: "resume" });
      else if (key === "y") this.done({ target, action: "retry" });
      else if (key === "c" && this.detail?.kind !== "task") this.done({ target, action: "reconfigure" });
      else if (key === "x") this.done({ target, action: "stop" });
    }
  }

  invalidate(): void {}

  private items(): Array<AgentRecord | TaskRecord> {
    return this.view === "tasks" ? this.state.tasks : this.state.agents;
  }

  private actionTarget(): string | undefined {
    if (this.view === "detail") return this.detail?.id;
    return this.items()[this.selected]?.id;
  }

  private listLines(): string[] {
    const agents = this.state.agents.filter((agent) => agent.status === "running").length;
    const activeTab = (label: string, active: boolean) => active
      ? this.theme.bg("selectedBg", this.theme.fg("accent", this.theme.bold(` ${label} `)))
      : this.theme.fg("muted", label);
    const title = `${this.theme.fg("accent", this.theme.bold("Agents"))}  ${agents} active · ${this.state.tasks.length} tasks  ${activeTab("Agents", this.view === "agents")} ${activeTab("Tasks", this.view === "tasks")}`;
    const lines = [title, this.theme.fg("dim", "tab switch · ↑↓ navigate · enter inspect · m message · p pause · r resume · y retry · c configure · x stop · esc close")];
    const items = this.items();
    this.selected = Math.min(this.selected, Math.max(0, items.length - 1));
    if (!items.length) lines.push(this.theme.fg("muted", this.view === "agents" ? "No agents. Use /subagent or subagent_spawn." : "No tasks."));
    items.forEach((item, index) => {
      const selected = index === this.selected;
      const marker = this.theme.fg(selected ? "accent" : "dim", selected ? "›" : " ");
      let row: string;
      if (this.view === "agents") {
        const agent = item as AgentRecord;
        const task = taskForAgent(this.state, agent);
        const status = task?.status ?? agent.status;
        row = [
          marker,
          selected ? this.theme.fg("accent", this.theme.bold(agent.name)) : this.theme.bold(agent.name),
          this.theme.fg("muted", `${agent.model.provider}/${agent.model.id}`),
          this.theme.fg(thinkingColor(agent.thinking), `thinking:${agent.thinking}`),
          task?.title ?? "idle",
          this.theme.fg(statusColor(status), `[${status}${task ? `/${task.phase}` : ""}]`),
        ].join("  ");
      } else {
        const task = item as TaskRecord;
        row = `${marker} ${this.theme.bold(task.id)}  ${task.title}  ${this.theme.fg(statusColor(task.status), `[${task.status}/${task.phase}]`)}  ${this.theme.fg("muted", task.agentId ?? "unassigned")}`;
      }
      lines.push(selected ? this.theme.bg("selectedBg", row) : row);
    });
    return lines;
  }

  private detailLines(): string[] {
    if (!this.detail) return ["No selection", "esc back"];
    if (this.detail.kind === "agent") {
      const agent = this.state.agents.find((candidate) => candidate.id === this.detail!.id);
      if (!agent) return ["Agent no longer exists", "esc back"];
      const tasks = this.state.tasks.filter((task) => task.agentId === agent.id || task.reviewAgentId === agent.id);
      const actions = this.state.actions.filter((action) => action.agentId === agent.id).slice(-20);
      return [
        `${this.theme.fg("accent", this.theme.bold(agent.name))} · ${agent.kind} · ${this.theme.fg(statusColor(agent.status), agent.status)}`,
        this.theme.fg("dim", "m message · p pause · r resume · y retry · c configure · x stop · esc back"),
        `Model: ${this.theme.fg("muted", `${agent.model.provider}/${agent.model.id}`)} · Thinking: ${this.theme.fg(thinkingColor(agent.thinking), agent.thinking)}`,
        `Session: ${this.theme.fg("muted", agent.sessionFile ?? "not started")}`,
        ...tasks.map((task) => `Task ${this.theme.bold(task.id)}: ${this.theme.fg(statusColor(task.status), `${task.status}/${task.phase}`)} · ${task.title}${task.error ? ` · ${this.theme.fg("error", task.error)}` : ""}`),
        this.theme.fg("accent", this.theme.bold("Recent transcript/actions")),
        ...actions.flatMap((action) => [this.theme.fg(action.isError ? "error" : "muted", `${action.at} ${action.action}${action.isError ? " [error]" : ""}`), ...(action.output ? action.output.split("\n").slice(0, 4).map((line) => `  ${line}`) : [])]),
      ];
    }
    const task = this.state.tasks.find((candidate) => candidate.id === this.detail!.id);
    if (!task) return ["Task no longer exists", "esc back"];
    const actions = this.state.actions.filter((action) => action.taskId === task.id).slice(-20);
    return [
      `${this.theme.fg("accent", this.theme.bold(task.title))} · ${this.theme.fg(statusColor(task.status), `${task.status}/${task.phase}`)}`,
      this.theme.fg("dim", "p pause · r resume · y retry · x stop · esc back"),
      `ID: ${this.theme.bold(task.id)} · Agent: ${task.agentId ?? "unassigned"} · Paths: ${task.paths.join(", ") || "none"}`,
      `Dependencies: ${task.dependsOn.join(", ") || "none"} · Turns: ${task.turns}/${task.maxTurns}`,
      ...(task.error ? [this.theme.fg("error", `Error: ${task.error}`)] : []),
      ...(task.output ? [this.theme.fg("accent", this.theme.bold("Latest output")), ...task.output.split("\n").slice(0, 12)] : []),
      this.theme.fg("accent", this.theme.bold("Recent transcript/actions")),
      ...actions.flatMap((action) => [this.theme.fg(action.isError ? "error" : "muted", `${action.at} ${action.action}${action.isError ? " [error]" : ""}`), ...(action.output ? action.output.split("\n").slice(0, 4).map((line) => `  ${line}`) : [])]),
    ];
  }
}
