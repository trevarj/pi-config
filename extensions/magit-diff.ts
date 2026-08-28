import { existsSync } from "node:fs";
import { hostname } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function forwardedEmacsSocket(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!env.SSH_CONNECTION) return undefined;
  const runtimeDir = env.XDG_RUNTIME_DIR || (process.getuid ? `/run/user/${process.getuid()}` : undefined);
  return env.PI_EMACS_SOCKET || (runtimeDir ? `${runtimeDir}/pi-emacs` : undefined);
}

export function magitDirectory(
  repository: string,
  env: NodeJS.ProcessEnv = process.env,
  remoteHostname = hostname(),
): string {
  if (!forwardedEmacsSocket(env)) return repository;
  const [, , sshHost, sshPort] = env.SSH_CONNECTION?.split(/\s+/) || [];
  const host = sshHost || remoteHostname;
  const port = sshPort && sshPort !== "22" ? `#${sshPort}` : "";
  return `${env.PI_DIFF_TRAMP_PREFIX || `/ssh:${env.USER}@${host}${port}:`}${repository}`;
}

export function emacsclientArgs(directory: string, socket?: string): string[] {
  return [
    ...(socket ? ["--socket-name", socket] : ["--alternate-editor", ""]),
    "--no-wait",
    "--reuse-frame",
    "--eval",
    `(progn (require 'magit) (magit-status ${JSON.stringify(directory)}))`,
  ];
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("diff", {
    description: "Open current repository in Magit",
    handler: async (_args, ctx) => {
      const git = await pi.exec("git", ["-C", ctx.cwd, "rev-parse", "--show-toplevel"], { timeout: 5_000 });
      if (git.code !== 0) {
        ctx.ui.notify(git.stderr.trim() || "Not inside a Git repository", "error");
        return;
      }

      const socket = forwardedEmacsSocket();
      if (socket && !existsSync(socket)) {
        ctx.ui.notify(`Forwarded Emacs socket not found: ${socket}`, "error");
        return;
      }

      const result = await pi.exec("emacsclient", emacsclientArgs(magitDirectory(git.stdout.trim()), socket), {
        timeout: 10_000,
      });
      if (result.code !== 0) {
        ctx.ui.notify(result.stderr.trim() || result.stdout.trim() || "emacsclient failed", "error");
      }
    },
  });
}
