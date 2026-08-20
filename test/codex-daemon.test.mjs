import test from "node:test";
import assert from "node:assert/strict";
import { CodexDaemonManager } from "../src/codex-daemon.mjs";

test("starts the official Codex daemon and records recovery state", async () => {
  const calls = [];
  let currentTime = 1_000;
  const manager = new CodexDaemonManager({
    bin: "/Applications/ChatGPT.app/Contents/Resources/codex",
    now: () => currentTime,
    run: async (bin, args, options) => {
      calls.push({ bin, args, options });
      return { stdout: '{"status":"already_running","backend":"pid"}\n' };
    }
  });

  const result = await manager.ensureRunning();
  assert.equal(result.attempted, true);
  assert.equal(result.status, "already_running");
  assert.deepEqual(calls[0].args, ["app-server", "daemon", "start"]);
  assert.equal(manager.snapshot().lastSuccessAt, 1_000);
  assert.equal(manager.snapshot().lastError, null);

  currentTime += 1_000;
  const cooledDown = await manager.ensureRunning();
  assert.equal(cooledDown.attempted, false);
  assert.equal(cooledDown.status, "cooldown");
  assert.equal(calls.length, 1);
});

test("coalesces concurrent daemon recovery requests", async () => {
  let resolveStart;
  let calls = 0;
  const manager = new CodexDaemonManager({
    bin: "/bin/codex",
    run: async () => {
      calls += 1;
      return new Promise((resolve) => { resolveStart = resolve; });
    }
  });

  const first = manager.ensureRunning();
  const second = manager.ensureRunning();
  assert.equal(manager.snapshot().recovering, true);
  resolveStart({ stdout: '{"status":"started"}\n' });
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.deepEqual(firstResult, secondResult);
  assert.equal(manager.snapshot().recovering, false);
});

test("surfaces daemon start failures for health reporting", async () => {
  const manager = new CodexDaemonManager({
    bin: "/bin/codex",
    run: async () => {
      const error = new Error("daemon failed");
      error.stderr = "managed executable is missing";
      throw error;
    }
  });

  await assert.rejects(manager.ensureRunning(), /daemon failed/);
  assert.equal(manager.snapshot().lastError, "managed executable is missing");
  assert.equal(manager.snapshot().lastSuccessAt, null);
});
