import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { AgentRecord, TaskRecord, TeamState } from "./types.ts";

export type DashboardAction = "message" | "pause" | "resume" | "retry" | "reconfigure" | "stop";
export interface DashboardSelection { target: string; action: DashboardAction }

type View = "agents" | "tasks" | "detail";

export function panelSummary(state: TeamState): string[] {
  const active = state.agents.filter((agent) => agent.status === "running");
  const queued = state.tasks.filter((task) => task.status === "queued" || task.status === "waiting");
  const blocked = state.tasks.filter((task) => task.status === "blocked" || task.status === "failed");
  if (!active.length && !queued.length && !blocked.length) return [];
  const lines = [`agents ${active.length} active · ${queued.length} queued${blocked.length ? ` · ${blocked.length} blocked` : ""}`];
  for (const agent of active.slice(0, 3)) {
    const task = state.tasks.find((candidate) => candidate.id === agent.taskId);
    lines.push(`  ${agent.name}: ${task?.title ?? agent.taskId ?? agent.status}`);
  }
  if (active.length > 3) lines.push(`  +${active.length - 3} more`);
  return lines;
}

export class AgentsDashboard {
  private selected = 0;
  private view: View = "agents";
  private detail?: { kind: "agent" | "task"; id: string };
  private readonly state: TeamState;
  private readonly done: (value: DashboardSelection | null) => void;

  constructor(state: TeamState, done: (value: DashboardSelection | null) => void) {
    this.state = state;
    this.done = done;
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
    const title = `Agents · ${agents} active / ${this.state.tasks.length} tasks · ${this.view === "agents" ? "[Agents] Tasks" : "Agents [Tasks]"}`;
    const lines = [title, "tab switch · ↑↓ navigate · enter detail · m message · p pause · r resume · y retry · c configure · x stop · esc close"];
    const items = this.items();
    if (!items.length) lines.push(this.view === "agents" ? "No agents. Use /subagent or subagent_spawn." : "No tasks.");
    items.forEach((item, index) => {
      const marker = index === this.selected ? ">" : " ";
      if (this.view === "agents") {
        const agent = item as AgentRecord;
        const task = this.state.tasks.find((candidate) => candidate.id === agent.taskId);
        lines.push(`${marker} ${agent.name} [${agent.kind}] ${agent.status} · ${task?.title ?? "idle"} · ${agent.model.provider}/${agent.model.id}:${agent.thinking}`);
      } else {
        const task = item as TaskRecord;
        lines.push(`${marker} ${task.id} [${task.phase}] ${task.status} · ${task.title} · ${task.agentId ?? "unassigned"}`);
      }
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
        `${agent.name} · ${agent.kind} · ${agent.status}`,
        "m message · p pause · r resume · y retry · c configure · x stop · esc back",
        `Model: ${agent.model.provider}/${agent.model.id}:${agent.thinking}`,
        `Session: ${agent.sessionFile ?? "not started"}`,
        ...tasks.map((task) => `Task ${task.id}: ${task.status}/${task.phase} · ${task.title}${task.error ? ` · ${task.error}` : ""}`),
        "Recent transcript/actions:",
        ...actions.flatMap((action) => [`${action.at} ${action.action}${action.isError ? " [error]" : ""}`, ...(action.output ? action.output.split("\n").slice(0, 4).map((line) => `  ${line}`) : [])]),
      ];
    }
    const task = this.state.tasks.find((candidate) => candidate.id === this.detail!.id);
    if (!task) return ["Task no longer exists", "esc back"];
    const actions = this.state.actions.filter((action) => action.taskId === task.id).slice(-20);
    return [
      `${task.title} · ${task.status}/${task.phase}`,
      "p pause · r resume · y retry · x stop · esc back",
      `ID: ${task.id} · Agent: ${task.agentId ?? "unassigned"} · Paths: ${task.paths.join(", ") || "none"}`,
      `Dependencies: ${task.dependsOn.join(", ") || "none"} · Turns: ${task.turns}/${task.maxTurns}`,
      ...(task.error ? [`Error: ${task.error}`] : []),
      ...(task.output ? ["Latest output:", ...task.output.split("\n").slice(0, 12)] : []),
      "Recent transcript/actions:",
      ...actions.flatMap((action) => [`${action.at} ${action.action}${action.isError ? " [error]" : ""}`, ...(action.output ? action.output.split("\n").slice(0, 4).map((line) => `  ${line}`) : [])]),
    ];
  }
}
