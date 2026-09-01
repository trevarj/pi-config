import { lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { LeaseRecord } from "./types.ts";

function normalizeInputPath(input: string): string {
  const normalized = input.normalize("NFC");
  const stripped = normalized.startsWith("@") ? normalized.slice(1) : normalized;
  if (stripped === "~") return homedir();
  if (stripped.startsWith("~/")) return join(homedir(), stripped.slice(2));
  return stripped;
}

export function normalizeLeasePath(repoRoot: string, input: string): string {
  const root = realpathSync(repoRoot);
  const raw = normalizeInputPath(input.trim() || ".");
  const absolute = resolve(root, raw);
  const rel = relative(root, absolute).split(sep).join("/");
  if (isAbsolute(rel) || rel === ".." || rel.startsWith("../")) {
    throw new Error(`Lease path escapes repository: ${input}`);
  }
  const normalized = rel === "" ? "." : rel.replace(/^\.\//, "").replace(/\/+$/, "");
  if (normalized === ".git" || normalized.startsWith(".git/") || normalized.includes("/.git/")) {
    throw new Error(`Lease path may not include .git: ${input}`);
  }
  rejectSymlinkComponents(root, normalized);
  return normalized || ".";
}

/** Match Pi's edit/write path semantics: strip @, expand ~, then resolve from child cwd. */
export function normalizeToolPath(repoRoot: string, cwd: string, input: string): string {
  const root = realpathSync(repoRoot);
  const raw = normalizeInputPath(input.trim());
  if (!raw) throw new Error("Tool path is required.");
  const absolute = isAbsolute(raw) ? resolve(raw) : resolve(cwd, raw);
  const rel = relative(root, absolute).split(sep).join("/");
  if (isAbsolute(rel) || rel === ".." || rel.startsWith("../")) {
    throw new Error(`Tool path escapes repository: ${input}`);
  }
  const normalized = rel === "" ? "." : rel.replace(/^\.\//, "").replace(/\/+$/, "");
  if (normalized === ".git" || normalized.startsWith(".git/") || normalized.includes("/.git/")) {
    throw new Error(`Tool path may not include .git: ${input}`);
  }
  rejectSymlinkComponents(root, normalized);
  return normalized;
}

function rejectSymlinkComponents(root: string, normalized: string): void {
  if (normalized === ".") return;
  let current = root;
  for (const part of normalized.split("/")) {
    current = resolve(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) throw new Error(`Lease path traverses a symlink: ${normalized}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

export function pathsOverlap(left: string, right: string): boolean {
  if (left === "." || right === ".") return true;
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

export function pathCovered(path: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => prefix === "." || path === prefix || path.startsWith(`${prefix}/`));
}

export function conflictingLease(
  paths: readonly string[],
  leases: readonly LeaseRecord[],
  ownTaskId?: string,
): LeaseRecord | undefined {
  return leases.find((lease) => lease.taskId !== ownTaskId
    && paths.some((path) => lease.paths.some((held) => pathsOverlap(path, held))));
}

export function dirtyConflict(paths: readonly string[], dirtyPaths: readonly string[]): string | undefined {
  return dirtyPaths.find((dirty) => paths.some((path) => pathsOverlap(path, dirty)));
}

export function acquireLease(
  leases: readonly LeaseRecord[],
  request: LeaseRecord,
  dirtyPaths: readonly string[],
  allowDirty: boolean,
): LeaseRecord[] {
  const overlap = conflictingLease(request.paths, leases, request.taskId);
  if (overlap) throw new Error(`Paths are queued behind task ${overlap.taskId}.`);
  const dirty = !allowDirty ? dirtyConflict(request.paths, dirtyPaths) : undefined;
  if (dirty) throw new Error(`Path ${dirty} is dirty or staged; set allowDirty explicitly.`);
  return [...leases.filter((lease) => lease.taskId !== request.taskId), request];
}

export function releaseLease(leases: readonly LeaseRecord[], taskId: string): LeaseRecord[] {
  return leases.filter((lease) => lease.taskId !== taskId);
}

/** Parse `git status --porcelain=v1 -z`; rename/copy records consume both paths. */
export function parseGitStatusZ(output: string): string[] {
  const records = output.split("\0");
  const paths: string[] = [];
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (!record || record.length < 4) continue;
    const status = record.slice(0, 2);
    const path = record.slice(3).replaceAll("\\", "/");
    if (path && path !== ".git" && !path.startsWith(".git/")) paths.push(path);
    if (status.includes("R") || status.includes("C")) {
      const other = records[++index]?.replaceAll("\\", "/");
      if (other && other !== ".git" && !other.startsWith(".git/")) paths.push(other);
    }
  }
  return [...new Set(paths)];
}
