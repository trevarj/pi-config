import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const WAITING_TOOLS = new Set(["plan_mode_question"]);

export function lastAssistantMessageIsQuestion(entries: any[]) {
  const entry = entries.findLast((candidate) => candidate?.message?.role === "assistant");
  const text = entry?.message?.content
    ?.filter((block: any) => block?.type === "text")
    .map((block: any) => block.text)
    .join("\n")
    .trim();
  return text?.endsWith("?") === true;
}

export default function herdrWaiting(pi: ExtensionAPI) {
  const active = new Set<string>();
  let awaitingReply = false;

  const setAwaitingReply = (active: boolean) => {
    if (active === awaitingReply) return;
    awaitingReply = active;
    pi.events.emit(
      "herdr:blocked",
      active ? { active, label: "waiting for input" } : { active },
    );
  };

  const release = (toolCallId: string) => {
    if (!active.delete(toolCallId)) return;
    pi.events.emit("herdr:blocked", { active: false });
  };

  pi.on("agent_start", () => setAwaitingReply(false));
  pi.on("agent_settled", (_event, ctx) => {
    setAwaitingReply(lastAssistantMessageIsQuestion(ctx.sessionManager.getBranch()));
  });
  pi.on("tool_execution_start", (event) => {
    if (!WAITING_TOOLS.has(event.toolName) || active.has(event.toolCallId)) return;
    active.add(event.toolCallId);
    pi.events.emit("herdr:blocked", { active: true, label: "waiting for input" });
  });
  pi.on("tool_execution_end", (event) => release(event.toolCallId));
  pi.on("session_shutdown", () => {
    setAwaitingReply(false);
    for (const toolCallId of active) release(toolCallId);
  });
}
