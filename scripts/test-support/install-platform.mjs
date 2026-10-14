// Test-only preload: isolate macOS and Feishu boundaries while running real installers.
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { syncBuiltinESMExports } from "node:module";
import { promisify } from "node:util";

const root = process.env.BRIDGE_INSTALL_TEST_ROOT;
if (!root || !path.isAbsolute(root) || !fs.existsSync(path.join(root, "TEST_ONLY"))) {
  throw new Error("Installer platform simulation requires an isolated test directory");
}
const userHome = path.join(root, "user");
const codex = "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex";
const socket = path.join(userHome, ".codex/app-server-control/app-server-control.sock");
const daemon = path.join(root, "daemon.json");
const agent = path.join(root, "agent.json");
const exists = fs.existsSync;
const access = fsp.access;
const runSync = childProcess.spawnSync;
os.homedir = () => userHome;
Object.defineProperty(process, "platform", { value: "darwin" });
fs.existsSync = (file) => String(file) === codex || exists(file);
fsp.access = async (file, mode) => String(file) === codex ? undefined : access(file, mode);

function response(stdout = "", status = 0, stderr = "") {
  return { status, stdout, stderr, signal: null, error: undefined };
}

function simulate(command, args = []) {
  fs.appendFileSync(path.join(root, "calls.jsonl"), JSON.stringify({ command, args }) + "\n");
  if (command === codex) {
    if (args[0] === "--version") return response("codex-cli test\n");
    if (args[2] === "bootstrap") return exists(daemon) ? response() : response("", 1, "standalone daemon is missing; run start first");
    if (args[2] === "start") {
      if (process.env.BRIDGE_TEST_DAEMON_FAIL === "1") return response("", 1, "daemon install failed");
      fs.mkdirSync(path.dirname(socket), { recursive: true });
      fs.writeFileSync(socket, "simulated socket");
      fs.writeFileSync(daemon, "{}");
      return response();
    }
    if (args[2] === "version") return exists(daemon)
      ? response(JSON.stringify({ status: "running", socketPath: socket, appServerVersion: "test" }))
      : response("", 1, "daemon not started");
  }
  if (command.endsWith("lark-cli")) {
    const profile = args[0] === "--profile" ? args[1] : null;
    const actual = profile ? args.slice(2) : args;
    const nativeReady = path.join(root, "lark-native-ready");
    if (actual[0] === "--version") { fs.writeFileSync(nativeReady, "ready"); return response("lark-cli test\n"); }
    if (actual[0] === "profile") return response(JSON.stringify([{ name: "paired", effective: true }]));
    if (actual[0] === "auth") {
      const available = process.env.BRIDGE_TEST_AUTH_FAIL !== "1";
      const prefix = exists(nativeReady) ? "" : "Installing native lark-cli executable...\n";
      fs.writeFileSync(nativeReady, "ready");
      return response(prefix + JSON.stringify({ identities: { bot: { available, appName: "test-bot" } }, appId: "cli_test" }));
    }
    throw new Error(`Unexpected Lark mutation: ${actual.join(" ")}`);
  }
  if (command === "/usr/bin/which") return response(`/test/bin/${args[0]}\n`);
  if (command.endsWith("ffmpeg")) return response("ffmpeg test\n");
  if (command === "/usr/bin/pgrep") return response("", 1);
  if (command === "plutil") return response("OK\n");
  if (command.endsWith("launchctl")) {
    if (args[0] === "getenv") return response("1\n");
    if (["enable", "setenv"].includes(args[0])) return response();
    if (args[0] === "print") {
      if (!args[1].endsWith("io.github.chengzeli7.feishu-codex-bridge") || !exists(agent)) return response("", 1);
      return process.env.BRIDGE_TEST_AGENT_STOPPED === "1"
        ? response("\tstate = waiting\n\tlast exit code = 1\n")
        : response("\tstate = running\n\tpid = 1234\n");
    }
    if (args[0] === "bootout") { if (exists(agent)) fs.unlinkSync(agent); return response(); }
    if (args[0] === "bootstrap") { fs.writeFileSync(agent, JSON.stringify({ plist: args[2] })); return response(); }
  }
  throw new Error(`Unexpected external installer command: ${command} ${args.join(" ")}`);
}

childProcess.spawnSync = (command, args, options) => command === process.execPath
  ? runSync(command, args, options) : simulate(command, args);
const fakeExecFile = () => { throw new Error("Use promisified execFile in installer tests"); };
fakeExecFile[promisify.custom] = async (command, args) => {
  const result = simulate(command, args);
  if (result.status) throw new Error(result.stderr || "simulated command failed");
  return { stdout: result.stdout, stderr: result.stderr };
};
childProcess.execFile = fakeExecFile;
childProcess.spawn = (command, args) => {
  if (!command.endsWith("lark-cli") || !args.includes("consume")) throw new Error("Unexpected asynchronous external command");
  fs.appendFileSync(path.join(root, "calls.jsonl"), JSON.stringify({ command, args }) + "\n");
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
  child.kill = () => true;
  setTimeout(() => {
    child.stderr.write("[event] ready event_key=im.message.receive_v1\n");
    child.stdout.write(JSON.stringify({ chat_type: "p2p", sender_type: "user", content: "配对 Codex 助手", sender_id: "ou_test", chat_id: "oc_test" }) + "\n");
    child.stdout.end(); child.stderr.end(); child.emit("exit", 0);
  }, 10);
  return child;
};
syncBuiltinESMExports();
