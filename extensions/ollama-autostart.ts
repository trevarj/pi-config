import { spawn } from "node:child_process";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const host = /^https?:\/\//.test(process.env.OLLAMA_HOST ?? "")
  ? process.env.OLLAMA_HOST!
  : `http://${process.env.OLLAMA_HOST || "127.0.0.1:11434"}`;
const versionUrl = new URL("/api/version", host).href;
let starting: Promise<boolean> | undefined;
const preparing = new Map<string, Promise<void>>();

export function isOllamaCloudModel(model: { provider?: string; id?: string }): boolean {
  return model.provider === "ollama-cloud" ||
    (model.provider === "ollama" && /(?:-|:)cloud$/.test(model.id ?? ""));
}

async function isRunning(): Promise<boolean> {
  try {
    return (await fetch(versionUrl, { signal: AbortSignal.timeout(500) })).ok;
  } catch {
    return false;
  }
}

async function startOllama(): Promise<boolean> {
  if (await isRunning()) return false;

  const child = spawn("ollama", ["serve"], { detached: true, stdio: "ignore" });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  child.unref();

  for (let attempt = 0; attempt < 20; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (await isRunning()) return true;
  }
  throw new Error(`Ollama did not become ready at ${host}`);
}

async function hasModel(id: string): Promise<boolean> {
  const response = await fetch(new URL("/api/tags", host));
  if (!response.ok) return false;
  const body = await response.json() as { models?: Array<{ name?: string }> };
  return body.models?.some((model) => model.name === id) ?? false;
}

export default function (pi: ExtensionAPI) {
  const prepare = async (model: Model<Api> | undefined, ctx: ExtensionContext) => {
    if (!model || !isOllamaCloudModel(model)) return;

    try {
      let pending = preparing.get(model.id);
      if (!pending) {
        pending = (async () => {
          starting ??= startOllama().finally(() => { starting = undefined; });
          if (await starting) ctx.ui.notify("Started Ollama server", "info");

          if (!await hasModel(model.id)) {
            ctx.ui.notify(`Adding ${model.id} to Ollama`, "info");
            const result = await pi.exec("ollama", ["pull", model.id], { timeout: 120_000 });
            if (result.code !== 0) throw new Error(result.stderr || result.stdout || "ollama pull failed");
          }
        })().finally(() => { preparing.delete(model.id); });
        preparing.set(model.id, pending);
      }
      await pending;
    } catch (error) {
      ctx.ui.notify(`Failed to prepare Ollama: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  };

  pi.on("model_select", (event, ctx) => prepare(event.model, ctx));
  pi.on("session_start", (_event, ctx) => prepare(ctx.model, ctx));
}
