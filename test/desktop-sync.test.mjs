import { EventEmitter } from "node:events";
import test from "node:test";
import assert from "node:assert/strict";
import { DesktopSync } from "../src/desktop-sync.mjs";

test("opens a Codex thread in the background for Desktop refresh", async () => {
  const calls = [];
  const sync = new DesktopSync({
    enabled: true,
    spawn(command, args, options) {
      calls.push({ command, args, options });
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("exit", 0, null));
      return child;
    }
  });
  const threadId = "019f0000-0000-7000-8000-000000000001";
  assert.equal(await sync.refreshThread(threadId), true);
  assert.deepEqual(calls[0], {
    command: "/usr/bin/open",
    args: ["-g", `codex://threads/${threadId}`],
    options: { stdio: "ignore" }
  });
});

test("does nothing when Desktop sync is disabled", async () => {
  const sync = new DesktopSync({ enabled: false, spawn: () => { throw new Error("must not spawn"); } });
  assert.equal(await sync.refreshThread("not-a-thread"), false);
});
