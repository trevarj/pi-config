import assert from "node:assert/strict";
import test from "node:test";
import ollamaAutostart, { isOllamaCloudModel } from "./ollama-autostart.ts";

test("recognizes direct and locally proxied Ollama Cloud models", () => {
  assert.equal(isOllamaCloudModel({ provider: "ollama-cloud", id: "qwen3.5" }), true);
  assert.equal(isOllamaCloudModel({ provider: "ollama", id: "qwen3.5:cloud" }), true);
  assert.equal(isOllamaCloudModel({ provider: "ollama", id: "gpt-oss:120b-cloud" }), true);
  assert.equal(isOllamaCloudModel({ provider: "ollama", id: "qwen3.5" }), false);
});

test("session shutdown aborts bounded model discovery", async () => {
  const originalFetch = globalThis.fetch;
  const handlers = new Map<string, (event: any, ctx: any) => unknown>();
  let tagsSignal: AbortSignal | undefined;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/version")) return new Response("{}", { status: 200 });
    tagsSignal = init?.signal ?? undefined;
    return new Promise<Response>((_resolve, reject) => {
      tagsSignal?.addEventListener("abort", () => reject(tagsSignal?.reason), { once: true });
    });
  }) as typeof fetch;
  try {
    ollamaAutostart({
      on(event: string, handler: (event: any, ctx: any) => unknown) { handlers.set(event, handler); },
      exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
    } as never);
    const ctx = {
      model: { provider: "ollama", id: "qwen:cloud" },
      ui: { notify() {} },
    };
    const pending = handlers.get("session_start")?.({}, ctx) as Promise<void>;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(tagsSignal?.aborted, false);
    handlers.get("session_shutdown")?.({}, ctx);
    await pending;
    assert.equal(tagsSignal?.aborted, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
