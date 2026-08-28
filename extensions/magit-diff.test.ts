import assert from "node:assert/strict";
import test from "node:test";
import { emacsclientArgs, forwardedEmacsSocket, magitDirectory } from "./magit-diff.ts";

test("uses local repository unless SSH socket forwarding is active", () => {
  assert.equal(magitDirectory("/repo", {}, "server"), "/repo");
  assert.equal(
    magitDirectory("/repo", {
      SSH_CONNECTION: "client 1 server 22",
      USER: "trev",
      XDG_RUNTIME_DIR: "/run/user/1000",
    }, "server"),
    "/ssh:trev@server:/repo",
  );
  assert.equal(
    magitDirectory("/repo", {
      SSH_CONNECTION: "client 1 server 22",
      USER: "trev",
      XDG_RUNTIME_DIR: "/run/user/1000",
      PI_DIFF_TRAMP_PREFIX: "/ssh:workbox:",
    }, "server"),
    "/ssh:workbox:/repo",
  );
});

test("builds safe emacsclient arguments for local and forwarded servers", () => {
  assert.equal(
    forwardedEmacsSocket({ SSH_CONNECTION: "client 1 server 22", XDG_RUNTIME_DIR: "/run/user/1000" }),
    "/run/user/1000/pi-emacs",
  );
  assert.deepEqual(emacsclientArgs('/repo/with "quotes"'), [
    "--no-wait",
    "--eval",
    '(progn (require \'magit) (magit-status "/repo/with \\"quotes\\""))',
  ]);
  assert.deepEqual(emacsclientArgs("/repo", "/tmp/server", true).slice(0, 3), [
    "--socket-name",
    "/tmp/server",
    "--tty",
  ]);
});
