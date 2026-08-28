import { connect } from "node:net";
import { hostname } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function bridgeSocket(env: NodeJS.ProcessEnv = process.env): string {
  const runtimeDir = env.XDG_RUNTIME_DIR;
  if (!runtimeDir) throw new Error("XDG_RUNTIME_DIR is unavailable");
  return env.SSH_CONNECTION
    ? `${runtimeDir}/pi-local-emacs.sock`
    : `${runtimeDir}/pi-bridge/emacs.sock`;
}

export function magitDirectory(
  repository: string,
  env: NodeJS.ProcessEnv = process.env,
  remoteHostname = hostname(),
): string {
  if (!env.SSH_CONNECTION) return repository;
  const [, , sshHost, sshPort] = env.SSH_CONNECTION.split(/\s+/);
  const host = sshHost || remoteHostname;
  const port = sshPort && sshPort !== "22" ? `#${sshPort}` : "";
  return `${env.PI_DIFF_TRAMP_PREFIX || `/ssh:${env.USER}@${host}${port}:`}${repository}`;
}

export function sendBridgeRequest(
  socketPath: string,
  directory: string,
  timeoutMs = 5_000,
): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let response = "";
    let failed: Error | undefined;
    const timeout = setTimeout(() => socket.destroy(new Error("Emacs bridge timed out")), timeoutMs);
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.end(`${JSON.stringify({ directory })}\n`));
    socket.on("data", (chunk) => {
      response += chunk;
      if (response.length > 8_192) socket.destroy(new Error("Emacs bridge response is too large"));
    });
    socket.on("error", (error) => { failed = error; });
    socket.on("close", () => {
      clearTimeout(timeout);
      if (failed) return reject(failed);
      try {
        const result: unknown = JSON.parse(response.trim());
        if (
          typeof result !== "object" || result === null || !("ok" in result) ||
          typeof result.ok !== "boolean" ||
          ("error" in result && result.error !== undefined && typeof result.error !== "string")
        ) throw new Error();
        resolve(result as { ok: boolean; error?: string });
      } catch {
        reject(new Error("Emacs bridge returned an invalid response"));
      }
    });
  });
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("diff", {
    description: "Open current repository in host Magit",
    handler: async (_args, ctx) => {
      const git = await pi.exec("git", ["-C", ctx.cwd, "rev-parse", "--show-toplevel"], { timeout: 5_000 });
      if (git.code !== 0) {
        ctx.ui.notify(git.stderr.trim() || "Not inside a Git repository", "error");
        return;
      }

      try {
        const result = await sendBridgeRequest(bridgeSocket(), magitDirectory(git.stdout.trim()));
        if (!result.ok) throw new Error(result.error || "Emacs bridge failed");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
}
