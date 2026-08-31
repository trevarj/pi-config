export type RenderTone = "success" | "warning" | "error";

export interface RenderSummary {
  text: string;
  tone: RenderTone;
}

type RecordValue = Record<string, unknown>;

const failedStates = new Set(["failed", "timed_out", "cancelled"]);

function record(value: unknown): RecordValue {
  return value && typeof value === "object" ? value as RecordValue : {};
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function count(value: number, singular: string): string {
  return `${value} ${singular}${value === 1 ? "" : "s"}`;
}

export function subagentCallSubject(name: string, args: unknown): string {
  const input = record(args);
  switch (name) {
    case "subagent_spawn":
      return "delegated job";
    case "subagent_inspect":
      return "jobs";
    case "subagent_cancel":
      return text(input.jobId) ?? "job";
    case "subagent_wait":
      return [text(input.jobId) ?? "job", typeof input.timeout === "number" ? `${input.timeout}s` : undefined]
        .filter(Boolean)
        .join(" · ");
    case "subagent_send":
      return text(input.recipient) ?? text(input.requestId) ?? "message";
    default:
      return "";
  }
}

export function summarizeSubagentResult(
  name: string,
  details: unknown,
  args: unknown = {},
  isError = false,
): RenderSummary {
  if (isError) return { text: "failed", tone: "error" };
  const value = record(details);
  const jobId = text(value.jobId);
  const state = text(value.state);

  if (name === "subagent_inspect") {
    const jobs = Array.isArray(value.jobs) ? value.jobs.map(record) : [];
    const states = new Map<string, number>();
    for (const job of jobs) {
      const jobState = text(job.state) ?? "unknown";
      states.set(jobState, (states.get(jobState) ?? 0) + 1);
    }
    const stateText = [...states].map(([jobState, total]) => `${total} ${jobState}`).join(" · ");
    const omitted = record(value.omitted).jobs;
    const omittedText = typeof omitted === "number" && omitted > 0 ? ` · ${omitted} omitted` : "";
    return {
      text: `${count(jobs.length, "job")}${stateText ? ` · ${stateText}` : ""}${omittedText}`,
      tone: "success",
    };
  }

  if (name === "subagent_wait") {
    if (value.interrupted === true) {
      return { text: `${jobId ?? "job"} · ${state ?? "active"} · message`, tone: "warning" };
    }
    if (value.timedOut === true) {
      return { text: `${jobId ?? "job"} · ${state ?? "active"} · wait expired`, tone: "warning" };
    }
  }

  if (name === "subagent_send") {
    const input = record(args);
    const requestId = text(value.requestId) ?? "message";
    if (value.duplicate === true) return { text: `${requestId} · already answered`, tone: "warning" };
    return {
      text: `${requestId} · ${text(input.requestId) ? "answered" : "sent"}`,
      tone: value.accepted === false ? "warning" : "success",
    };
  }

  const summary = [jobId, state].filter(Boolean).join(" · ") || "done";
  return { text: summary, tone: state && failedStates.has(state) ? "error" : "success" };
}

export function resultText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      const item = record(part);
      return item.type === "text" && typeof item.text === "string" ? item.text : "";
    })
    .filter(Boolean)
    .join("\n");
}
