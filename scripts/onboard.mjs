import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractVerificationUrl, hasAvailableBot } from "../src/onboarding.mjs";
import { VERSION } from "../src/version.mjs";
import { DESKTOP_CODEX_BIN } from "../src/desktop-runtime.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const supportRoot = path.join(os.homedir(), "Library", "Application Support", "CodexFeishuBridge");
const configPath = path.join(supportRoot, "config.json");
const bundledLark = path.join(projectRoot, "node_modules", ".bin", "lark-cli");
const larkBin = existsSync(bundledLark) ? bundledLark : "lark-cli";
const quietEnv = {
  ...process.env,
  PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ""}`,
  BRIDGE_CONFIG: configPath,
  LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1",
  LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1"
};

function heading(index, title) {
  console.log(`\n[${index}/5] ${title}`);
}

function runNode(relative, args = []) {
  const result = spawnSync(process.execPath, [path.join(projectRoot, relative), ...args], {
    cwd: projectRoot,
    stdio: "inherit",
    env: quietEnv
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${relative} exited with ${result.status}`);
}

function botAvailable(profile = null) {
  const result = spawnSync(larkBin, [...(profile ? ["--profile", profile] : []), "auth", "status", "--json", "--verify"], {
    cwd: projectRoot,
    encoding: "utf8",
    env: quietEnv
  });
  if (result.status !== 0) return false;
  return hasAvailableBot(result.stdout);
}

async function createFeishuApp() {
  console.log("Opening the official Feishu one-click app creation flow…");
  await new Promise((resolve, reject) => {
    const child = spawn(larkBin, ["config", "init", "--new", "--brand", "feishu", "--lang", "zh"], {
      cwd: projectRoot,
      stdio: ["inherit", "pipe", "pipe"],
      env: quietEnv
    });
    let opened = false;
    let observed = "";
    const forward = (stream, output) => stream.on("data", (chunk) => {
      const text = chunk.toString();
      output.write(text);
      if (opened) return;
      observed = `${observed}${text}`.slice(-32_768);
      const url = extractVerificationUrl(observed);
      if (!url) return;
      opened = true;
      console.log(`\nFeishu setup link: ${url}`);
      spawn("/usr/bin/open", [url], { detached: true, stdio: "ignore" }).unref();
    });
    forward(child.stdout, process.stdout);
    forward(child.stderr, process.stderr);
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`Feishu app creation exited with ${code}`)));
  });
  if (!botAvailable()) throw new Error("Feishu app creation finished, but the bot identity is not available");
}

async function main() {
  if (process.platform !== "darwin") throw new Error(`v${VERSION} guided installation currently supports macOS only`);
  if (Number(process.versions.node.split(".")[0]) < 20) throw new Error("Node.js 20 or later is required");
  await mkdir(supportRoot, { recursive: true, mode: 0o700 });

  heading(1, "Check prerequisites");
  if (!existsSync(DESKTOP_CODEX_BIN)) {
    throw new Error("ChatGPT Desktop is not installed at /Applications/ChatGPT.app");
  }
  if (!existsSync(bundledLark) && spawnSync("/usr/bin/which", ["lark-cli"]).status !== 0) {
    throw new Error("lark-cli is unavailable; install project dependencies with npm ci");
  }
  // With npm --ignore-scripts, lark-cli downloads its native executable on its
  // first invocation. Keep those setup logs out of the JSON auth response.
  const larkVersion = spawnSync(larkBin, ["--version"], { cwd: projectRoot, stdio: "inherit", env: quietEnv });
  if (larkVersion.error) throw larkVersion.error;
  if (larkVersion.status !== 0) throw new Error("lark-cli executable initialization failed; the existing bot was not changed");
  console.log("Prerequisites are ready.");

  heading(2, "Create or reuse a Feishu app");
  const existing = existsSync(configPath) ? JSON.parse(await readFile(configPath, "utf8")) : null;
  if (existing) {
    if (!existing.larkProfile) throw new Error("Existing installation has no pinned larkProfile. Identify its original bot profile before upgrading; no app or pairing was changed.");
    if (!botAvailable(existing.larkProfile)) throw new Error(`The installed bot profile ${existing.larkProfile} is unavailable. Repair this profile before upgrading; no replacement app was created.`);
    console.log(`Reusing installed Feishu profile: ${existing.larkProfile}`);
  } else if (botAvailable()) console.log("A verified Feishu bot profile already exists; reusing it.");
  else await createFeishuApp();

  heading(3, "Pair your private chat and choose workspaces");
  if (existsSync(configPath)) console.log(`Existing bridge configuration found: ${configPath}`);
  else runNode("scripts/setup.mjs");

  heading(4, "Run health checks and install the background service");
  runNode("scripts/doctor.mjs", ["--preflight", "--lark-bin", larkBin]);
  runNode("scripts/service.mjs", ["install"]);
  runNode("scripts/doctor.mjs");
  runNode("scripts/service.mjs", ["status"]);

  heading(5, "Setup complete");
  console.log(`Feishu Codex Bridge is installed.

If this was the first shared-daemon setup while Desktop was open, quit and reopen
Desktop once. Existing shared-daemon installations do not need a restart on every upgrade.

Open the bot in Feishu and send:
  版本
  健康
  任务

Configuration: ${configPath}
Service checks passed. Real Feishu delivery and task continuation still need
verification; send “健康” and a harmless test request to the paired bot.`);
}

main().catch((error) => {
  console.error(`\nSETUP FAILED  ${error.message}`);
  process.exitCode = 1;
});
