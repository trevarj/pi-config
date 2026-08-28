import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

const SKIPPABLE_COMPACTION_ERRORS = new Set([
  "Already compacted",
  "Nothing to compact (session too small)",
]);

function paneId(output: string): string {
  const id = JSON.parse(output)?.result?.pane?.pane_id;
  if (typeof id !== "string") throw new Error("Herdr split returned no pane ID");
  return id;
}

async function compact(ctx: ExtensionCommandContext, steering: string): Promise<void> {
  try {
    await new Promise<void>((resolve, reject) => {
      ctx.compact({
        customInstructions: steering
          ? `Preserve context needed for this fork: ${steering}`
          : "Preserve context needed to continue work in a forked session",
        onComplete: () => resolve(),
        onError: reject,
      });
    });
  } catch (error) {
    if (!SKIPPABLE_COMPACTION_ERRORS.has(error instanceof Error ? error.message : String(error))) throw error;
  }
}

export async function forkInHerdr(
  pi: Pick<ExtensionAPI, "exec">,
  ctx: ExtensionCommandContext,
  steering: string,
): Promise<{ name: string; pane: string }> {
  if (process.env.HERDR_ENV !== "1") throw new Error("/fork requires a Herdr-managed pane");

  await ctx.waitForIdle();

  const session = ctx.sessionManager.getSessionFile();
  if (!session) throw new Error("Current session is not persisted yet");

  await compact(ctx, steering);

  const direction = (process.stdout.columns ?? 0) >= 2 * (process.stdout.rows ?? 1) ? "right" : "down";
  const split = await pi.exec(
    "herdr",
    ["pane", "split", "--current", "--direction", direction, "--cwd", ctx.cwd, "--no-focus"],
    { timeout: 10_000 },
  );
  if (split.code !== 0) throw new Error(split.stderr || split.stdout || "Herdr pane split failed");

  const pane = paneId(split.stdout);
  const name = `fork-${randomUUID().slice(0, 8)}`;

  try {
    const start = await pi.exec(
      "herdr",
      ["agent", "start", name, "--kind", "pi", "--pane", pane, "--timeout", "30000", "--", "--fork", session],
      { timeout: 35_000 },
    );
    if (start.code !== 0) throw new Error(start.stderr || start.stdout || "Herdr failed to start Pi");

    if (steering) {
      const prompt = await pi.exec("herdr", ["agent", "prompt", name, steering], { timeout: 10_000 });
      if (prompt.code !== 0) throw new Error(prompt.stderr || prompt.stdout || "Herdr failed to steer fork");
    }
  } catch (error) {
    await pi.exec("herdr", ["pane", "close", pane], { timeout: 10_000 });
    throw error;
  }

  return { name, pane };
}

export default function herdrFork(pi: ExtensionAPI) {
  pi.registerCommand("fork", {
    description: "Compact context and fork into a new Pi pane",
    handler: async (args, ctx) => {
      const steering = args.trim();

      try {
        const fork = await forkInHerdr(pi, ctx, steering);
        ctx.ui.notify(`Started ${fork.name} in ${fork.pane}`, "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
}
