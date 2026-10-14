import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const preload = path.join(repository, "scripts/test-support/install-platform.mjs");

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "bridge-install-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "TEST_ONLY"), "isolated installer test");
  const source = path.join(root, "source");
  await mkdir(source);
  for (const entry of ["src", "scripts", "bin", "package.json"]) await cp(path.join(repository, entry), path.join(source, entry), { recursive: true });
  await mkdir(path.join(source, "node_modules/.bin"), { recursive: true });
  await mkdir(path.join(source, "node_modules/fake-lark"), { recursive: true });
  await writeFile(path.join(source, "node_modules/fake-lark/cli.mjs"), "// simulated external boundary\n");
  await symlink("../fake-lark/cli.mjs", path.join(source, "node_modules/.bin/lark-cli"));
  await writeFile(path.join(source, ".env.local"), "TEST_ONLY=1\n");
  const support = path.join(root, "user/Library/Application Support/CodexFeishuBridge");
  await mkdir(support, { recursive: true });
  const workspace = path.join(root, "workspace"); await mkdir(workspace);
  const configPath = path.join(support, "config.json");
  const statePath = path.join(support, "custom-data/state.json");
  const env = { ...process.env, BRIDGE_INSTALL_TEST_ROOT: root, NODE_OPTIONS: `--import=${JSON.stringify(preload)}` };
  delete env.BRIDGE_CONFIG;
  const execute = (script, args = [], options = {}) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(options.source ?? source, script), ...args], {
      cwd: options.source ?? source, env: { ...env, ...options.env }, stdio: ["pipe", "pipe", "pipe"]
    });
    let output = "", cursor = 0;
    const prompts = [["项目代号（默认 my-project）：", "project"], ["项目绝对路径：", workspace],
      ["自然语言别名，逗号分隔（可留空）：", "日常"], ["继续添加项目？[y/N]：", "n"], ["默认项目（默认 project）：", "project"]];
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`Installer test timed out:\n${output}`)); }, 15000);
    const receive = (chunk) => {
      output += chunk.toString();
      if (prompts[cursor] && output.includes(prompts[cursor][0])) child.stdin.write(prompts[cursor++][1] + "\n");
    };
    child.stdout.on("data", receive); child.stderr.on("data", receive);
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, output }); });
  });
  const config = { allowedUserIds: ["ou_test"], allowedChatIds: ["oc_test"], workspaces: { project: workspace }, defaultWorkspace: "project",
    larkProfile: "original-bot", larkBin: "/missing/old-release/lark-cli", stateFile: statePath,
    codexBin: "/Applications/ChatGPT.app/Contents/Resources/codex", desktopSyncEnabled: true,
    codexAppServerSocket: path.join(root, "user/.codex/app-server-control/app-server-control.sock") };
  return { root, source, support, configPath, statePath, config, execute };
}

test("first installation runs actual pairing/setup before bootstrap, then verifies the installed daemon", async (t) => {
  const f = await fixture(t);
  const result = await f.execute("scripts/onboard.mjs");
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /PREFLIGHT ONLY/);
  assert.match(result.output, /PASS  official app-server daemon/);
  const config = JSON.parse(await readFile(f.configPath, "utf8"));
  assert.equal(config.larkProfile, "paired");
  assert.deepEqual(config.allowedUserIds, ["ou_test"]);
  assert.equal((await stat(f.configPath)).mode & 0o777, 0o600);
  const calls = (await readFile(path.join(f.root, "calls.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  const bootstrap = calls.findIndex((c) => c.args.includes("bootstrap") && c.command.endsWith("/codex"));
  assert.ok(bootstrap > 0);
  assert.ok(calls.slice(0, bootstrap).some((c) => c.args[2] === "start"), "start installs the missing daemon before bootstrap");
  const larkCalls = calls.filter((c) => c.command.endsWith("lark-cli"));
  assert.deepEqual(larkCalls[0].args, ["--version"], "native bootstrap logs must not contaminate JSON auth");
});

test("upgrade pins the existing bot and keeps state, workspaces, backups and dependencies independent of the source", async (t) => {
  const f = await fixture(t);
  await mkdir(path.dirname(f.statePath), { recursive: true });
  const state = '{"queued":[{"text":"preserve this"}]}\n'; await writeFile(f.statePath, state);
  const original = JSON.stringify(f.config); await writeFile(f.configPath, original, { mode: 0o600 });
  const result = await f.execute("scripts/onboard.mjs");
  assert.equal(result.code, 0, result.output);
  const config = JSON.parse(await readFile(f.configPath, "utf8"));
  assert.equal(config.larkProfile, "original-bot");
  assert.deepEqual(config.workspaces, f.config.workspaces);
  assert.equal(config.stateFile, f.statePath);
  assert.equal(await readFile(f.statePath, "utf8"), state);
  const backup = (await readdir(f.support)).find((name) => name.startsWith("config.json.backup-"));
  assert.equal(await readFile(path.join(f.support, backup), "utf8"), original);
  const calls = (await readFile(path.join(f.root, "calls.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  const auth = calls.filter((c) => c.args.includes("auth"));
  assert.ok(auth.length >= 3);
  assert.ok(auth.every((c) => c.args[0] === "--profile" && c.args[1] === "original-bot"));
  assert.equal(calls.some((c) => c.args.includes("consume") || c.args.includes("init")), false);
  const release = path.dirname(path.dirname(path.dirname(config.larkBin)));
  assert.equal(await readlink(config.larkBin), "../fake-lark/cli.mjs");
  assert.equal((await readdir(release)).includes(".env.local"), false);
  const plist = await readFile(path.join(f.root, "user/Library/LaunchAgents/io.github.chengzeli7.feishu-codex-bridge.plist"), "utf8");
  assert.ok(plist.includes(`${path.dirname(process.execPath)}:/opt/homebrew/bin`));
  await rename(f.source, `${f.source}-removed`);
  await stat(config.larkBin);
  const doctor = await f.execute("bin/feishu-codex-bridge.mjs", ["doctor"], { source: release });
  assert.equal(doctor.code, 0, doctor.output);
  assert.match(doctor.output, /PASS  official app-server daemon/);
});

test("invalid installed bot fails before changing configuration, pairing or services", async (t) => {
  const f = await fixture(t); const original = JSON.stringify(f.config); await writeFile(f.configPath, original);
  const result = await f.execute("scripts/onboard.mjs", [], { env: { BRIDGE_TEST_AUTH_FAIL: "1" } });
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /no replacement app was created/);
  assert.equal(await readFile(f.configPath, "utf8"), original);
  const calls = await readFile(path.join(f.root, "calls.jsonl"), "utf8");
  assert.doesNotMatch(calls, /launchctl|"consume"|"init"/);
});

test("loaded but stopped LaunchAgent is a failing installation status", async (t) => {
  const f = await fixture(t); await writeFile(f.configPath, JSON.stringify(f.config));
  const install = await f.execute("scripts/onboard.mjs"); assert.equal(install.code, 0, install.output);
  const status = await f.execute("scripts/service.mjs", ["status"], { env: { BRIDGE_TEST_AGENT_STOPPED: "1" } });
  assert.equal(status.code, 1, status.output);
  assert.match(status.output, /state = waiting/);
});

test("source migration keeps original state, attachment and spool paths instead of copying only state", async (t) => {
  const f = await fixture(t);
  const config = { ...f.config, stateFile: "./data/state.json", attachmentsDir: "./data/files", eventSpoolDir: "./data/incoming" };
  await writeFile(path.join(f.source, "config.local.json"), JSON.stringify(config));
  const result = await f.execute("scripts/service.mjs", ["install"]);
  assert.equal(result.code, 0, result.output);
  const installed = JSON.parse(await readFile(f.configPath, "utf8"));
  for (const key of ["stateFile", "attachmentsDir", "eventSpoolDir"]) assert.equal(installed[key], path.resolve(f.source, config[key]));
});

test("daemon installation failure leaves the existing configuration and Bridge untouched", async (t) => {
  const f = await fixture(t); const original = JSON.stringify(f.config); await writeFile(f.configPath, original);
  await writeFile(path.join(f.root, "agent.json"), "existing agent");
  const result = await f.execute("scripts/service.mjs", ["install"], { env: { BRIDGE_TEST_DAEMON_FAIL: "1" } });
  assert.equal(result.code, 1, result.output);
  assert.equal(await readFile(f.configPath, "utf8"), original);
  assert.equal(await readFile(path.join(f.root, "agent.json"), "utf8"), "existing agent");
  assert.equal((await readdir(f.support)).includes("releases"), false);
  assert.doesNotMatch(await readFile(path.join(f.root, "calls.jsonl"), "utf8"), /"bootout"/);
});

test("missing bridge configuration is rejected before daemon or service changes", async (t) => {
  const f = await fixture(t);
  const result = await f.execute("scripts/service.mjs", ["install"]);
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /configuration is missing/);
  assert.equal((await readdir(f.root)).includes("calls.jsonl"), false);
});

test("an upgrade reuses a healthy shared daemon without restarting other Codex work", async (t) => {
  const f = await fixture(t); await writeFile(f.configPath, JSON.stringify(f.config));
  const first = await f.execute("scripts/onboard.mjs"); assert.equal(first.code, 0, first.output);
  await writeFile(path.join(f.root, "calls.jsonl"), "");
  const second = await f.execute("scripts/service.mjs", ["install"]); assert.equal(second.code, 0, second.output);
  const calls = (await readFile(path.join(f.root, "calls.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(calls.some((c) => c.command.endsWith("/codex") && ["start", "bootstrap", "restart", "update", "stop"].includes(c.args[2])), false);
});
