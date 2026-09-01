import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import childExtension from "./child.ts";
import { Coordinator, privacySnapshot } from "./coordinator.ts";
export { privacySnapshot } from "./coordinator.ts";
import { resolveModelQuery } from "./scheduler.ts";
import {
  MAX_ACTIVE_TURNS,
  MAX_AGENTS,
  MAX_TASK_TURNS,
  MAX_TASKS,
  type ActionRecord,
  type AgentInput,
  type TaskInput,
} from "./types.ts";

const WAIT_LIMIT_SECONDS = 3600;
const MAIN_TOOL_NAMES = [
  "subagent_spawn",
  "subagent_add_tasks",
  "subagent_models",
  "subagent_inspect",
  "subagent_send",
  "subagent_manage",
  "subagent_wait",
] as const;

const AgentSchema = Type.Object({
  id: Type.Optional(Type.String({ maxLength: 64 })),
  name: Type.String({ minLength: 1, maxLength: 64 }),
  kind: StringEnum(["explorer", "implementer", "reviewer", "general"] as const),
  model: Type.Optional(Type.String({ description: "Exact provider/id, exact ID/name, or unique query. No fallback." })),
  thinking: Type.Optional(StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const)),
  instructions: Type.Optional(Type.String({ maxLength: 16 * 1024 })),
  lifetime: Type.Optional(StringEnum(["team", "task"] as const)),
  tools: Type.Optional(Type.Array(Type.String(), { maxItems: 32 })),
}, { additionalProperties: false });

const TaskSchema = Type.Object({
  id: Type.Optional(Type.String({ maxLength: 64 })),
  title: Type.Optional(Type.String({ maxLength: 120 })),
  prompt: Type.String({ minLength: 1, maxLength: 48 * 1024 }),
  kind: Type.Optional(StringEnum(["explorer", "implementer", "reviewer", "general"] as const)),
  agent: Type.Optional(Type.String({ description: "Agent ID or name." })),
  dependsOn: Type.Optional(Type.Array(Type.String(), { maxItems: 32 })),
  paths: Type.Optional(Type.Array(Type.String(), { maxItems: 32 })),
  allowDirty: Type.Optional(Type.Boolean()),
  mutating: Type.Optional(Type.Boolean()),
  autoReview: Type.Optional(Type.Boolean()),
  context: Type.Optional(StringEnum(["bounded", "fresh", "full"] as const)),
  gitAuthority: Type.Optional(StringEnum(["none", "commit", "full"] as const)),
  maxTurns: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
  timeoutMinutes: Type.Optional(Type.Number({ minimum: 1, maximum: 1440 })),
}, { additionalProperties: false });


function textResult(value: unknown, details: unknown = value) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }], details };
}

export default function piAgents(pi: ExtensionAPI): void {
  if (process.env.PI_AGENTS_ROLE === "child") {
    childExtension(pi);
    return;
  }

  const coordinator = new Coordinator(pi);
  let proactiveGuidelinePending = true;

  pi.registerEntryRenderer("pi-agents-action", (entry, { expanded }, theme) => {
    const action = entry.data as ActionRecord;
    const status = action.isError ? theme.fg("error", "failed") : theme.fg("accent", action.action);
    const target = [action.agentId, action.taskId].filter(Boolean).join("/");
    let text = `${status}${target ? ` ${theme.fg("muted", target)}` : ""}`;
    if (action.output) text += `\n${expanded ? action.output : action.output.split("\n").slice(0, 4).join("\n")}`;
    return new Text(text, 0, 0);
  });

  pi.registerTool({
    name: "subagent_spawn",
    label: "Spawn Agent Team",
    description: `Atomically create agents[] and tasks[] as a dependency DAG. Scheduler caps: ${MAX_ACTIVE_TURNS} active turns, ${MAX_AGENTS} agents, ${MAX_TASKS} tasks, ${MAX_TASK_TURNS} turns and 60 minutes per task.`,
    promptSnippet: "Create a bounded persistent agent team and task DAG",
    promptGuidelines: ["Use subagent_spawn only for bounded delegated tracks; do not recursively delegate from children."],
    parameters: Type.Object({
      agents: Type.Array(AgentSchema, { minItems: 1, maxItems: MAX_AGENTS }),
      tasks: Type.Array(TaskSchema, { minItems: 1, maxItems: MAX_TASKS }),
    }, { additionalProperties: false }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      await coordinator.authorizeElevation(params.tasks as TaskInput[], ctx);
      return textResult(coordinator.addPlan(params.agents as AgentInput[], params.tasks as TaskInput[]));
    },
    renderCall(args, theme) {
      return new Text(theme.fg("toolTitle", `subagent_spawn ${args.agents.length} agents / ${args.tasks.length} tasks`), 0, 0);
    },
  });

  pi.registerTool({
    name: "subagent_add_tasks",
    label: "Add Agent Tasks",
    description: "Atomically add tasks to the existing team DAG without changing existing agents.",
    parameters: Type.Object({ tasks: Type.Array(TaskSchema, { minItems: 1, maxItems: MAX_TASKS }) }, { additionalProperties: false }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      await coordinator.authorizeElevation(params.tasks as TaskInput[], ctx);
      return textResult({ taskIds: coordinator.addTasks(params.tasks as TaskInput[]) });
    },
  });

  pi.registerTool({
    name: "subagent_models",
    label: "Agent Models",
    description: "List available child models or resolve one exact/unique query without fallback.",
    parameters: Type.Object({ query: Type.Optional(Type.String()) }, { additionalProperties: false }),
    async execute(_id, params) {
      return params.query
        ? textResult(resolveModelQuery(params.query, coordinator.models, undefined))
        : textResult(coordinator.models);
    },
  });

  pi.registerTool({
    name: "subagent_inspect",
    label: "Inspect Agents",
    description: "Inspect bounded team, task, mailbox, action, and output state. Private thinking is never stored.",
    parameters: Type.Object({ id: Type.Optional(Type.String()) }, { additionalProperties: false }),
    async execute(_id, params) { return textResult(coordinator.inspect(params.id)); },
  });

  pi.registerTool({
    name: "subagent_send",
    label: "Message Agent",
    description: "Send a persistent plain-text mailbox message to a named logical agent.",
    parameters: Type.Object({
      to: Type.String({ minLength: 1, maxLength: 64 }),
      message: Type.String({ minLength: 1, maxLength: 48 * 1024 }),
    }, { additionalProperties: false }),
    async execute(_id, params) { return textResult({ messageId: coordinator.send(params.to, params.message) }); },
  });

  pi.registerTool({
    name: "subagent_manage",
    label: "Manage Agents",
    description: "Pause, resume, retry, reconfigure, or stop a logical agent or task.",
    parameters: Type.Object({
      action: StringEnum(["pause", "resume", "retry", "reconfigure", "stop", "set_concurrency"] as const),
      target: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
      concurrency: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_AGENTS })),
      model: Type.Optional(Type.String()),
      thinking: Type.Optional(StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const)),
    }, { additionalProperties: false }),
    async execute(_id, params) {
      await coordinator.manage(params);
      return textResult({ ok: true, action: params.action, target: params.target });
    },
  });

  pi.registerTool({
    name: "subagent_wait",
    label: "Wait for Agents",
    description: "Wait for all or any selected tasks to become final/blocked. Timeout does not cancel work.",
    parameters: Type.Object({
      taskIds: Type.Optional(Type.Array(Type.String(), { maxItems: MAX_TASKS })),
      mode: Type.Optional(StringEnum(["all", "any"] as const)),
      timeout: Type.Optional(Type.Number({ minimum: 0, maximum: WAIT_LIMIT_SECONDS })),
    }, { additionalProperties: false }),
    async execute(_id, params, signal) {
      const reached = await coordinator.wait(params.taskIds ?? [], params.mode ?? "all", params.timeout ?? 30, signal);
      return textResult({ timedOut: !reached, state: coordinator.inspect() });
    },
  });

  pi.registerCommand("subagent", {
    description: "Route a natural delegation prompt through the lead model",
    handler: async (args, ctx) => {
      const prompt = args.trim();
      if (!prompt) {
        ctx.ui.notify("Usage: /subagent <natural prompt>", "error");
        return;
      }
      const routed = `Delegate this request using the Pi agent-team tools. You remain lead and must verify the result: ${prompt}`;
      pi.sendUserMessage(routed, ctx.isIdle() ? undefined : { deliverAs: "followUp" });
    },
  });

  pi.registerCommand("agents", {
    description: "Open the keyboard agent dashboard",
    handler: async (_args, ctx) => coordinator.dashboard(ctx),
  });

  pi.on("session_start", async (_event, ctx) => {
    proactiveGuidelinePending = true;
    await coordinator.start(ctx);
  });
  pi.on("session_shutdown", (_event, ctx) => coordinator.shutdown(ctx));
  pi.on("model_select", (_event, ctx) => coordinator.updateParent(ctx));
  pi.on("thinking_level_select", (_event, ctx) => coordinator.updateParent(ctx));
  pi.on("input", (event) => {
    if (event.source === "interactive" || event.source === "rpc") proactiveGuidelinePending = true;
  });
  pi.on("before_agent_start", (event) => {
    if (!proactiveGuidelinePending) return;
    proactiveGuidelinePending = false;
    if (/\b(?:delegate|subagent|agent team|\/subagent)\b/i.test(event.prompt ?? "")) return;
    return {
      systemPrompt: `${event.systemPrompt}\n\nAt the beginning of this task only: if it clearly contains at least two substantial independent work tracks, ask once whether the user wants delegation. Do not ask later, do not ask for a single track, and skip the question when the user already requested or rejected delegation.`,
    };
  });
  pi.events.on("pi-agents:snapshot:request", () => {
    try { pi.events.emit("pi-agents:snapshot", privacySnapshot(coordinator.current)); } catch { /* session not started */ }
  });

  // Exported by registration rather than a profile file; child mode registers a disjoint tool set.
  void MAIN_TOOL_NAMES;
}
