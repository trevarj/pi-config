import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import test from "node:test";
import { bridgeSocket, magitDirectory, sendBridgeRequest } from "./magit-diff.ts";

test("selects host or reverse-forwarded bridge and builds TRAMP paths", () => {
  assert.equal(bridgeSocket({ XDG_RUNTIME_DIR: "/run/user/1000" }), "/run/user/1000/pi-bridge/emacs.sock");
  assert.equal(
    bridgeSocket({ XDG_RUNTIME_DIR: "/run/user/1000", SSH_CONNECTION: "client 1 server 22" }),
    "/run/user/1000/pi-local-emacs.sock",
  );
  assert.equal(magitDirectory("/repo", {}, "server"), "/repo");
  assert.equal(
    magitDirectory("/repo", { SSH_CONNECTION: "client 1 server 22", USER: "trev" }, "fallback"),
    "/ssh:trev@server:/repo",
  );
  assert.equal(
    magitDirectory("/repo", {
      SSH_CONNECTION: "client 1 server 2222",
      PI_DIFF_TRAMP_PREFIX: "/ssh:workbox:",
    }),
    "/ssh:workbox:/repo",
  );
});

test("sends a bounded JSON request to the bridge", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-emacs-bridge-test-"));
  const socketPath = join(directory, "bridge.sock");
  const server = createServer((socket) => {
    socket.once("data", (data) => {
      assert.deepEqual(JSON.parse(data.toString()), { directory: '/repo/with "quotes"' });
      socket.end('{"ok":true}\n');
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });

  try {
    assert.deepEqual(await sendBridgeRequest(socketPath, '/repo/with "quotes"'), { ok: true });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});
