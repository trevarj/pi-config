import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { STATE_VERSION, TERMINAL_RETENTION_MS, type TeamState, isTaskTerminal } from "./types.ts";

export function stateRoot(parentSessionId: string, agentDir = getAgentDir()): string {
  const safe = parentSessionId.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 128) || "ephemeral";
  return join(agentDir, "subagents", safe);
}

export function statePath(parentSessionId: string, agentDir = getAgentDir()): string {
  return join(stateRoot(parentSessionId, agentDir), "state.json");
}

export function readState(path: string): TeamState | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as TeamState;
    if (parsed.version !== STATE_VERSION) throw new Error(`Unsupported pi-agents state version: ${String(parsed.version)}`);
    if (!Array.isArray(parsed.agents) || !Array.isArray(parsed.tasks) || !Array.isArray(parsed.leases)) {
      throw new Error("Invalid pi-agents state shape.");
    }
    parsed.maxConcurrent ??= 4;
    for (const agent of parsed.agents) {
      agent.instructions ??= "";
      agent.lifetime ??= "team";
    }
    for (const task of parsed.tasks) {
      task.maxTurns ??= 50;
      task.timeoutMs ??= 60 * 60 * 1000;
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export function writeStateAtomic(path: string, state: TeamState): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  const next: TeamState = { ...state, updatedAt: new Date().toISOString() };
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(temporary, 0o600);
  const file = openSync(temporary, "r");
  try { fsyncSync(file); } finally { closeSync(file); }
  renameSync(temporary, path);
  chmodSync(path, 0o600);
  const directory = openSync(dirname(path), "r");
  try { fsyncSync(directory); } finally { closeSync(directory); }
}

export function recoverState(state: TeamState, now = new Date().toISOString()): TeamState {
  const agents = state.agents.map((agent) =>
    !["failed", "stopped"].includes(agent.status)
      ? { ...agent, status: "paused" as const, updatedAt: now }
      : agent,
  );
  const tasks = state.tasks.map((task) =>
    !isTaskTerminal(task.status) && task.status !== "blocked"
      ? { ...task, status: "paused" as const, updatedAt: now }
      : task,
  );
  return { ...state, agents, tasks, gitOwner: undefined, updatedAt: now };
}

export function markTerminal(state: TeamState, now = new Date().toISOString()): TeamState {
  if (!state.tasks.length || !state.tasks.every((task) => isTaskTerminal(task.status))) {
    return { ...state, terminalAt: undefined };
  }
  return { ...state, terminalAt: state.terminalAt ?? now };
}

export function pruneTerminalStates(agentDir = getAgentDir(), now = Date.now()): string[] {
  const root = join(agentDir, "subagents");
  const removed: string[] = [];
  let directories: string[];
  try {
    directories = readdirSync(root);
  } catch {
    return removed;
  }
  for (const name of directories) {
    const directory = join(root, name);
    const path = join(directory, "state.json");
    try {
      const state = readState(path);
      if (!state?.terminalAt) continue;
      const terminalAt = Date.parse(state.terminalAt);
      const fallback = statSync(path).mtimeMs;
      if (now - (Number.isFinite(terminalAt) ? terminalAt : fallback) < TERMINAL_RETENTION_MS) continue;
      rmSync(directory, { recursive: true, force: true });
      removed.push(name);
    } catch {
      // Corrupt state is preserved for manual recovery rather than silently deleted.
    }
  }
  return removed;
}
