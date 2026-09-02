import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { registerChildRuntime } from "../child.ts";
import piAgents, { privacySnapshot } from "../index.ts";
import { createEmptyState } from "../scheduler.ts";
import type { AgentRecord, TaskRecord } from "../types.ts";
import { AgentsDashboard, panelSummary } from "../ui.ts";

function records() {
  const tools = new Map<string, Record<string, any>>();
  const commands = new Map<string, Record<string, any>>();
  const handlers = new Map<string, (...args: any[]) => any>();
  const eventHandlers = new Map<string, (data: unknown) => void>();
  const api = {
    registerTool: (tool: Record<string, any>) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: Record<string, any>) => commands.set(name, command),
    registerEntryRenderer: () => {},
    on: (event: string, handler: (...args: any[]) => any) => handlers.set(event, handler),
    appendEntry: () => {},
    sendMessage: () => {},
    sendUserMessage: () => {},
    exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
    events: {
      on: (event: string, handler: (data: unknown) => void) => eventHandlers.set(event, handler),
      emit: () => {},
    },
  } as unknown as ExtensionAPI;
  piAgents(api);
  return { tools, commands, handlers, eventHandlers };
}

function fixture() {
  const state = createEmptyState("s", "/repo", "/repo");
  const agent: AgentRecord = {
    id: "worker", name: "worker", kind: "implementer", model: { provider: "p", id: "m" }, thinking: "high",
    instructions: "", lifetime: "team", status: "running", taskId: "task", createdAt: "now", updatedAt: "now",
  };
  const task: TaskRecord = {
    id: "task", title: "Implement feature", prompt: "secret prompt", kind: "implementer", agentId: "worker",
    dependsOn: [], paths: ["src"], allowDirty: false, mutating: true, autoReview: true, contextMode: "bounded",
    gitAuthority: "none", status: "running", phase: "implement", attempts: 1, retries: 0, turns: 2,
    createdAt: "now", updatedAt: "now", reviewFingerprints: [], maxTurns: 50, timeoutMs: 60 * 60 * 1000,
  };
  state.agents.push(agent);
  state.tasks.push(task);
  return state;
}

test("parent extension registers the exact main tool and command surface with strict schemas", () => {
  const { tools, commands } = records();
  assert.deepEqual([...tools.keys()], [
    "subagent_spawn", "subagent_add_tasks", "subagent_models", "subagent_inspect",
    "subagent_send", "subagent_manage", "subagent_wait",
  ]);
  assert.deepEqual([...commands.keys()], ["subagent", "agents"]);
  const spawn = tools.get("subagent_spawn")!;
  assert.deepEqual(spawn.parameters.required, ["agents", "tasks"]);
  assert.equal(spawn.parameters.additionalProperties, false);
  const task = spawn.parameters.properties.tasks.items;
  assert.equal(task.additionalProperties, false);
  assert.ok(task.properties.allowDirty);
  assert.ok(task.properties.autoReview);
  assert.ok(task.properties.gitAuthority);
  const rendered = spawn.renderCall({ agents: [{ name: "a" }], tasks: [{ prompt: "t" }] }, {
    fg: (_color: string, text: string) => text,
  });
  assert.deepEqual(rendered.render(100).map((line: string) => line.trimEnd()), ["subagent_spawn 1 agents / 1 tasks"]);
});

test("child extension registers only collaboration tools with strict completion/review schemas", () => {
  const tools = new Map<string, Record<string, any>>();
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  registerChildRuntime({
    registerTool: (tool: Record<string, any>) => tools.set(tool.name, tool),
    registerCommand: () => {},
    on: (event: string, handler: (...args: unknown[]) => unknown) => handlers.set(event, handler),
    exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
  } as unknown as ExtensionAPI, {
    request: async () => ({}),
  }, { agentId: "agent", taskId: "task" });
  assert.deepEqual([...tools.keys()], ["team_status", "team_claim_paths", "team_add_task", "team_complete", "team_send"]);
  assert.ok(!tools.has("subagent_spawn"));
  const complete = tools.get("team_complete")!.parameters;
  assert.deepEqual(complete.required, ["status", "summary"]);
  assert.deepEqual(complete.properties.review.required, ["decision", "summary"]);
  assert.equal(complete.additionalProperties, false);
  assert.ok(handlers.has("tool_call"));
  assert.ok(handlers.has("tool_result"));
});

test("proactive delegation guideline is injected once and skipped for explicit delegation", () => {
  const first = records();
  const handler = first.handlers.get("before_agent_start")!;
  const result = handler({ prompt: "Build two independent services", systemPrompt: "base" }, {});
  assert.match(result.systemPrompt, /beginning of this task only/);
  assert.equal(handler({ prompt: "another", systemPrompt: "base" }, {}), undefined);
  first.handlers.get("input")?.({ source: "interactive" }, {});
  assert.match(handler({ prompt: "new user task", systemPrompt: "base" }, {}).systemPrompt, /beginning of this task only/);
  const explicit = records().handlers.get("before_agent_start")!;
  assert.equal(explicit({ prompt: "delegate this with subagents", systemPrompt: "base" }, {}), undefined);
});

test("privacy snapshot and compact widget omit private data while showing agent work and dashboard hint", () => {
  const state = fixture();
  const snapshot = privacySnapshot(state);
  const serialized = JSON.stringify(snapshot);
  assert.ok(!serialized.includes("secret prompt"));
  assert.ok(!serialized.includes("src"));
  assert.equal(snapshot.active, 1);

  const summary = panelSummary(state);
  assert.match(summary[0], /Agents  1 active · 0 queued.*\/agents opens selectable view/);
  assert.match(summary[1], /worker · p\/m · high · Implement feature · \[running\/implement\]/);
  assert.ok(panelSummary(state, undefined, 36).every((line) => visibleWidth(line) <= 36));
});

test("keyboard dashboard styles complete rows, stays width-bounded, and navigates into live detail", () => {
  let state = fixture();
  state.agents.push({
    ...state.agents[0], id: "reviewer", name: "reviewer", kind: "reviewer", taskId: "review",
    model: { provider: "anthropic", id: "claude-sonnet" }, thinking: "xhigh",
  });
  state.tasks.push({
    ...state.tasks[0], id: "review", title: "Review implementation", agentId: undefined,
    reviewAgentId: "reviewer", status: "reviewing", phase: "review",
  });
  const theme = {
    fg: (_color: Parameters<Theme["fg"]>[0], text: string) => `\x1b[32m${text}\x1b[39m`,
    bg: (_color: Parameters<Theme["bg"]>[0], text: string) => `\x1b[44m${text}\x1b[49m`,
    bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
  } as Pick<Theme, "fg" | "bg" | "bold">;
  const selections: unknown[] = [];
  const dashboard = new AgentsDashboard(() => state, (value) => selections.push(value), theme);
  let lines = dashboard.render(86);
  assert.ok(lines.every((line) => visibleWidth(line) <= 86));
  assert.ok(lines.some((line) => line.includes("worker") && line.includes("p/m") && line.includes("thinking:high") && line.includes("Implement feature") && line.includes("running/implement")));
  assert.match(lines.join("\n"), /\x1b\[/);

  dashboard.handleInput("\x1b[B");
  lines = dashboard.render(120);
  assert.ok(lines.some((line) => line.includes("›") && line.includes("reviewer")));
  dashboard.handleInput("\r");
  lines = dashboard.render(120);
  assert.ok(lines[0].includes("reviewer"));
  assert.ok(lines.some((line) => line.includes("anthropic/claude-sonnet") && line.includes("Thinking:") && line.includes("xhigh")));
  assert.ok(lines.some((line) => line.includes("Review implementation") && line.includes("reviewing/review")));

  dashboard.handleInput("\x1b");
  state = {
    ...state,
    tasks: state.tasks.map((task) => task.id === "review" ? { ...task, title: "Review updated live", status: "completed" } : task),
  };
  assert.ok(dashboard.render(120).some((line) => line.includes("Review updated live") && line.includes("completed/review")));

  const actionDashboard = new AgentsDashboard(fixture(), (value) => selections.push(value));
  const help = actionDashboard.render(72).slice(1, 3).join(" ");
  for (const action of ["message", "pause", "retry", "configure", "stop"]) assert.ok(help.includes(action));
  actionDashboard.handleInput("m");
  assert.deepEqual(selections, [{ target: "worker", action: "message" }]);
});
