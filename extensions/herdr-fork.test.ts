import assert from "node:assert/strict";
import test from "node:test";
import { forkInHerdr } from "./herdr-fork.ts";

test("compacts, starts a forked Pi, and optionally sends steering through Herdr", async () => {
  const previousHerdrEnv = process.env.HERDR_ENV;
  process.env.HERDR_ENV = "1";

  try {
    for (const steering of ["", "review error handling"]) {
      const calls: string[][] = [];
      const result = await forkInHerdr({
        exec: async (_command: string, args: string[]) => {
          calls.push(args);
          if (args[0] === "pane" && args[1] === "split") {
            return { code: 0, stdout: JSON.stringify({ result: { pane: { pane_id: "w1:p2" } } }), stderr: "" };
          }
          return { code: 0, stdout: "", stderr: "" };
        },
      } as any, {
        compact: ({ onComplete }: { onComplete: () => void }) => onComplete(),
        cwd: "/repo",
        waitForIdle: async () => {},
        sessionManager: { getSessionFile: () => "/tmp/session.jsonl" },
      } as any, steering);

      assert.match(result.name, /^fork-[0-9a-f]{8}$/);
      assert.equal(result.pane, "w1:p2");
      assert.deepEqual(calls[1].slice(0, 8), [
        "agent", "start", result.name, "--kind", "pi", "--pane", "w1:p2", "--timeout",
      ]);
      assert.deepEqual(calls[2], steering
        ? ["agent", "prompt", result.name, steering]
        : undefined);
    }
  } finally {
    if (previousHerdrEnv === undefined) delete process.env.HERDR_ENV;
    else process.env.HERDR_ENV = previousHerdrEnv;
  }
});
