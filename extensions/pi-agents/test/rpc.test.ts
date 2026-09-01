import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { JsonlDecoder, RpcProcess, buildChildInvocation, encodeJsonl, toolsForKind } from "../rpc.ts";

const fakeChild = String.raw`
import net from "node:net";
let stdin = "";
const ipc = new net.Socket({ fd: 3, readable: true, writable: true });
let ipcBuffer = "";
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  stdin += chunk;
  for (;;) {
    const at = stdin.indexOf("\n");
    if (at < 0) break;
    const command = JSON.parse(stdin.slice(0, at));
    stdin = stdin.slice(at + 1);
    if (command.type === "get_state") send({ id: command.id, type: "response", command: "get_state", success: true, data: { sessionFile: "/tmp/fake.jsonl" } });
    else if (command.type === "prompt") {
      send({ id: command.id, type: "response", command: "prompt", success: true });
      ipc.write(JSON.stringify({ type: "request", id: "child-1", method: "status", params: { taskId: "t" } }) + "\n");
    } else if (command.type === "abort") send({ id: command.id, type: "response", command: "abort", success: true });
  }
});
ipc.setEncoding("utf8");
ipc.on("data", (chunk) => {
  ipcBuffer += chunk;
  const at = ipcBuffer.indexOf("\n");
  if (at < 0) return;
  const response = JSON.parse(ipcBuffer.slice(0, at));
  send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "ipc:" + response.result.ok }] } });
  send({ type: "agent_settled" });
});
`;

test("strict JSONL decoder splits LF only, keeps Unicode separators, and rejects unterminated frames", () => {
  const frames: Record<string, unknown>[] = [];
  const decoder = new JsonlDecoder((frame) => frames.push(frame));
  decoder.push(Buffer.from('{"x":"a\u2028b"}\r\n{"y":'));
  assert.deepEqual(frames, [{ x: "a b" }]);
  decoder.push(Buffer.from("2}\n"));
  assert.deepEqual(frames[1], { y: 2 });
  decoder.finish();
  const bad = new JsonlDecoder(() => {});
  bad.push('{"x":1}');
  assert.throws(() => bad.finish(), /unterminated/);
  assert.equal(encodeJsonl({ type: "x" }), '{"type":"x"}\n');
});

test("RPC process uses persistent stdio plus inherited private IPC fd with a fake child", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-agents-rpc-"));
  const script = join(directory, "fake.mjs");
  writeFileSync(script, fakeChild);
  const events: Record<string, unknown>[] = [];
  const calls: unknown[][] = [];
  const rpc = new RpcProcess({
    invocation: { command: process.execPath, args: [script], cwd: directory, env: process.env },
    onEvent: (event) => events.push(event),
    onIpcRequest: async (method, params) => {
      calls.push([method, params]);
      return { ok: true };
    },
  });
  const state = await rpc.start();
  assert.equal(state.sessionFile, "/tmp/fake.jsonl");
  await rpc.prompt("hello");
  for (let count = 0; count < 50 && !events.some((event) => event.type === "agent_settled"); count++) await delay(10);
  assert.deepEqual(calls, [["status", { taskId: "t" }]]);
  assert.equal((events.find((event) => event.type === "message_end")?.message as { content: Array<{ text: string }> }).content[0].text, "ipc:true");
  assert.ok(events.some((event) => event.type === "agent_settled"));
  rpc.close();
});

test("child invocation allowlists only reviewed extensions/tools and Anthropic auth conditionally", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-agents-package-"));
  const packageRoot = join(root, "@trevarj", "pi-agents");
  const webRoot = join(root, "pi-web-access");
  const authRoot = join(root, "@gotgenes", "pi-anthropic-auth");
  for (const path of [packageRoot, webRoot, authRoot]) mkdirSync(path, { recursive: true });
  const invocation = buildChildInvocation({
    packageRoot, cwd: "/repo", sessionDir: "/sessions", agentId: "a", agentName: "a", taskId: "t",
    kind: "explorer", model: { provider: "anthropic", id: "claude" }, thinking: "high", trustedProject: true,
    runtimeInstructions: "runtime only", mutating: false, finalize: false,
  });
  assert.ok(invocation.args.includes("--no-extensions"));
  assert.ok(invocation.args.includes(packageRoot));
  assert.ok(invocation.args.includes(webRoot));
  assert.ok(invocation.args.includes(authRoot));
  assert.ok(invocation.args.includes("--approve"));
  const tools = invocation.args[invocation.args.indexOf("--tools") + 1].split(",");
  assert.ok(tools.includes("team_complete"));
  assert.ok(tools.includes("web_search"));
  assert.ok(!tools.includes("edit"));
  assert.ok(!tools.includes("subagent_spawn"));
  assert.ok(toolsForKind("implementer", { mutating: true, finalize: false }).includes("edit"));
  assert.ok(!toolsForKind("reviewer", { mutating: false, finalize: false }).includes("bash"));
});
