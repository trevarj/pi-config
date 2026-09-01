import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const host = /^https?:\/\//.test(process.env.OLLAMA_HOST ?? "")
  ? process.env.OLLAMA_HOST!
  : `http://${process.env.OLLAMA_HOST || "127.0.0.1:11434"}`;
const versionUrl = new URL("/api/version", host).href;

export function isOllamaCloudModel(model: { provider?: string; id?: string }): boolean {
  return model.provider === "ollama-cloud" ||
    (model.provider === "ollama" && /(?:-|:)cloud$/.test(model.id ?? ""));
}

async function isRunning(signal: AbortSignal): Promise<boolean> {
  signal.throwIfAborted();
  try {
    return (await fetch(versionUrl, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(500)]),
    })).ok;
  } catch {
    signal.throwIfAborted();
    return false;
  }
}

async function startOllama(signal: AbortSignal): Promise<void> {
  if (await isRunning(signal)) return;
  signal.throwIfAborted();

  const child = spawn("ollama", ["serve"], { detached: true, stdio: "ignore" });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  child.unref();

  for (let attempt = 0; attempt < 20; attempt += 1) {
    await delay(250, undefined, { signal });
    if (await isRunning(signal)) return;
  }
  throw new Error(`Ollama did not become ready at ${host}`);
}

async function hasModel(id: string, signal: AbortSignal): Promise<boolean> {
  const response = await fetch(new URL("/api/tags", host), {
    signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
  });
  if (!response.ok) return false;
  const body = await response.json() as { models?: Array<{ name?: string }> };
  return body.models?.some((model) => model.name === id) ?? false;
}

export default function (pi: ExtensionAPI) {
  let sessionController = new AbortController();
  let preparationController = new AbortController();
  let generation = 0;
  let lastContext: ExtensionContext | undefined;
  let starting: Promise<void> | undefined;

  const setStatus = (ctx: ExtensionContext, value: string | undefined) => {
    try {
      ctx.ui.setStatus("ollama", value);
    } catch {
      // Session replacement can stale an in-flight model preparation context.
    }
  };
  const notifyError = (ctx: ExtensionContext, message: string) => {
    try {
      ctx.ui.notify(message, "error");
    } catch {
      // A replacement session owns subsequent UI.
    }
  };
  const ensureServer = async (signal: AbortSignal) => {
    for (;;) {
      signal.throwIfAborted();
      if (!starting) {
        const task = startOllama(signal);
        starting = task;
        void task.finally(() => {
          if (starting === task) starting = undefined;
        }).catch(() => {});
      }
      const task = starting;
      try {
        await task;
        return;
      } catch (error) {
        signal.throwIfAborted();
        if (!(error && typeof error === "object" && "name" in error && error.name === "AbortError")) {
          throw error;
        }
      }
    }
  };
  const prepare = async (
    model: Model<Api> | undefined,
    ctx: ExtensionContext,
    signal: AbortSignal,
    ownerGeneration: number,
  ) => {
    const ownsStatus = () => ownerGeneration === generation && !signal.aborted;
    if (!model || !isOllamaCloudModel(model)) {
      if (ownsStatus()) setStatus(ctx, undefined);
      return;
    }

    if (ownsStatus()) setStatus(ctx, `preparing ${model.id}`);
    try {
      await ensureServer(signal);
      if (!await hasModel(model.id, signal)) {
        if (ownsStatus()) setStatus(ctx, `pulling ${model.id}`);
        const result = await pi.exec("ollama", ["pull", model.id], {
          timeout: 120_000,
          signal,
        });
        if (result.code !== 0) throw new Error(result.stderr || result.stdout || "ollama pull failed");
      }
    } catch (error) {
      if (signal.aborted) return;
      if (ownsStatus()) {
        notifyError(ctx, `Failed to prepare Ollama: ${error instanceof Error ? error.message : String(error)}`);
      }
    } finally {
      if (ownsStatus()) setStatus(ctx, undefined);
    }
  };
  const begin = (model: Model<Api> | undefined, ctx: ExtensionContext) => {
    preparationController.abort(new DOMException("Ollama preparation replaced", "AbortError"));
    preparationController = new AbortController();
    const ownerGeneration = ++generation;
    lastContext = ctx;
    const signal = AbortSignal.any([sessionController.signal, preparationController.signal]);
    return prepare(model, ctx, signal, ownerGeneration);
  };

  pi.on("model_select", (event, ctx) => begin(event.model, ctx));
  pi.on("session_start", (_event, ctx) => {
    sessionController.abort(new DOMException("Ollama session replaced", "AbortError"));
    sessionController = new AbortController();
    return begin(ctx.model, ctx);
  });
  pi.on("session_shutdown", () => {
    generation += 1;
    preparationController.abort(new DOMException("Ollama session shut down", "AbortError"));
    sessionController.abort(new DOMException("Ollama session shut down", "AbortError"));
    if (lastContext) setStatus(lastContext, undefined);
    lastContext = undefined;
  });
}
