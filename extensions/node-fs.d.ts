declare module "node:assert/strict";
declare module "node:os";
declare module "node:path";
declare module "node:test";

declare module "node:fs" {
  export function mkdtempSync(prefix: string): string;
  export function readFileSync(path: string, encoding: "utf8"): string;
  export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
  export function writeFileSync(path: string, data: string): void;
}
