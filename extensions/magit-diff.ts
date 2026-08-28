import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { hostname } from "node:os";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

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

function magitForm(directory: string): string {
  return `(progn (require 'magit) (magit-status ${JSON.stringify(directory)}))`;
}

export function emacsclientArgs(directory: string, socket?: string, tty = false): string[] {
  return [
    ...(socket ? ["--socket-name", socket] : []),
    tty ? "--tty" : "--no-wait",
    "--eval",
    magitForm(directory),
  ];
}

async function openTerminalMagit(
  directory: string,
  socket: string | undefined,
  ctx: ExtensionCommandContext,
): Promise<string | undefined> {
  const localSocket = `${process.env.XDG_RUNTIME_DIR || ""}/emacs/server`;
  const useClient = Boolean(socket || existsSync(localSocket));
  const command = useClient ? "emacsclient" : "emacs";
  const args = useClient
    ? emacsclientArgs(directory, socket, true)
    : ["--no-window-system", "--eval", magitForm(directory)];

  return ctx.ui.custom<string | undefined>((tui, _theme, _keybindings, done) => {
    queueMicrotask(() => {
      tui.stop();
      const child = spawn(command, args, { cwd: ctx.cwd, stdio: "inherit" });
      let finished = false;
      const finish = (error?: string) => {
        if (finished) return;
        finished = true;
        tui.start();
        tui.requestRender(true);
        done(error);
      };
      child.once("error", (error) => finish(error.message));
      child.once("close", (code) => finish(code ? `${command} exited with status ${code}` : undefined));
    });

    return { render: () => ["Opening Magit in terminal..."], invalidate() {} };
  });
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

      const forwarded = forwardedEmacsSocket();
      const socket = forwarded && existsSync(forwarded) ? forwarded : undefined;
      const directory = socket ? magitDirectory(git.stdout.trim()) : git.stdout.trim();
      const result = await pi.exec("emacsclient", emacsclientArgs(directory, socket), { timeout: 10_000 });
      if (result.code === 0) return;

      if (ctx.mode !== "tui") {
        ctx.ui.notify(result.stderr.trim() || result.stdout.trim() || "emacsclient failed", "error");
        return;
      }
      const error = await openTerminalMagit(directory, socket, ctx);
      if (error) ctx.ui.notify(error, "error");
    },
  });
}
