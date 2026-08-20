import test from "node:test";
import assert from "node:assert/strict";
import { DESKTOP_DAEMON_ENV, enableDesktopDaemonEnvironment } from "../src/desktop-daemon-env.mjs";

test("enables the shared Codex daemon environment when it is missing", () => {
  const calls = [];
  const result = enableDesktopDaemonEnvironment({
    platform: "darwin",
    run(command, args) {
      calls.push({ command, args });
      if (args[0] === "getenv") return { status: 1, stdout: "", stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    }
  });
  assert.deepEqual(result, { enabled: true, changed: true });
  assert.deepEqual(calls, [
    { command: "/bin/launchctl", args: ["getenv", DESKTOP_DAEMON_ENV] },
    { command: "/bin/launchctl", args: ["setenv", DESKTOP_DAEMON_ENV, "1"] }
  ]);
});

test("keeps an existing shared Codex daemon environment", () => {
  const calls = [];
  const result = enableDesktopDaemonEnvironment({
    platform: "darwin",
    run(command, args) {
      calls.push({ command, args });
      return { status: 0, stdout: "1\n", stderr: "" };
    }
  });
  assert.deepEqual(result, { enabled: true, changed: false });
  assert.equal(calls.length, 1);
});

test("does not touch launchctl outside macOS", () => {
  const result = enableDesktopDaemonEnvironment({
    platform: "linux",
    run() { throw new Error("must not run"); }
  });
  assert.deepEqual(result, { enabled: false, changed: false });
});
