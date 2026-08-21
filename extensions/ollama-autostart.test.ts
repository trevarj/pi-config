import assert from "node:assert/strict";
import test from "node:test";
import { isOllamaCloudModel } from "./ollama-autostart.ts";

test("recognizes direct and locally proxied Ollama Cloud models", () => {
  assert.equal(isOllamaCloudModel({ provider: "ollama-cloud", id: "qwen3.5" }), true);
  assert.equal(isOllamaCloudModel({ provider: "ollama", id: "qwen3.5:cloud" }), true);
  assert.equal(isOllamaCloudModel({ provider: "ollama", id: "gpt-oss:120b-cloud" }), true);
  assert.equal(isOllamaCloudModel({ provider: "ollama", id: "qwen3.5" }), false);
});
