import { cp, chmod, copyFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultCodexAppServerSocket } from "../src/config.mjs";
import { enableDesktopDaemonEnvironment } from "../src/desktop-daemon-env.mjs";

const LABEL = "io.github.chengzeli7.feishu-codex-bridge";
const VERSION = "0.1.0";
const DESKTOP_CODEX_BIN = "/Applications/ChatGPT.app/Contents/Resources/codex";
const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const userHome = os.homedir();
const supportRoot = path.join(userHome, "Library", "Application Support", "CodexFeishuBridge");
const releasesRoot = path.join(supportRoot, "releases");
const configPath = path.join(supportRoot, "config.json");
const dataRoot = path.join(supportRoot, "data");
const logsRoot = path.join(userHome, "Library", "Logs", "CodexFeishuBridge");
const agentsRoot = path.join(userHome, "Library", "LaunchAgents");
const plistPath = path.join(agentsRoot, `${LABEL}.plist`);
const domain = `gui/${process.getuid()}`;

function shell(command, args, { allowFailure = false, capture = false } = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: capture ? "pipe" : "inherit" });
  if (result.error) throw result.error;
  if (!allowFailure && result.status !== 0) throw new Error(`${command} exited with ${result.status}`);
  return result;
}

function xml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function stamp() {
  return new Date().toISOString().replaceAll(/[:.]/g, "-");
}

function waitForOfficialDaemon(timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = spawnSync(DESKTOP_CODEX_BIN, ["app-server", "daemon", "version"], { encoding: "utf8", timeout: 2_500 });
    if (result.status === 0) {
      try {
        const status = JSON.parse(result.stdout);
        if (status.status === "running" && status.socketPath === defaultCodexAppServerSocket()) return;
      } catch {
        // Retry until the official daemon is accepting protocol requests.
      }
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  throw new Error("official Codex app-server daemon did not become ready within 15 seconds");
}

function launchAgentLoaded() {
  return spawnSync("launchctl", ["print", `${domain}/${LABEL}`], { stdio: "ignore" }).status === 0;
}

function waitForLaunchAgentState(expectedLoaded, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (launchAgentLoaded() === expectedLoaded) return true;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  return launchAgentLoaded() === expectedLoaded;
}

function bootstrapLaunchAgent() {
  let failure = "launchctl bootstrap did not run";
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (launchAgentLoaded()) return;
    const result = shell("launchctl", ["bootstrap", domain, plistPath], { allowFailure: true, capture: true });
    if (result.status === 0 || launchAgentLoaded()) return;
    failure = result.stderr.trim() || `launchctl bootstrap exited with ${result.status}`;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }
  throw new Error(failure);
}

async function install() {
  const desktopWasRunning = spawnSync("/usr/bin/pgrep", ["-x", "ChatGPT"], { stdio: "ignore" }).status === 0;
  const releaseRoot = path.join(releasesRoot, `${VERSION}-${stamp()}`);
  await mkdir(releasesRoot, { recursive: true, mode: 0o700 });
  await cp(sourceRoot, releaseRoot, {
    recursive: true,
    filter(source) {
      const relative = path.relative(sourceRoot, source);
      if (!relative) return true;
      const top = relative.split(path.sep)[0];
      return !["data", "dist", ".git", "config.local.json"].includes(top);
    }
  });
  await mkdir(dataRoot, { recursive: true, mode: 0o700 });
  await mkdir(logsRoot, { recursive: true, mode: 0o700 });
  await mkdir(agentsRoot, { recursive: true });

  const sourceConfigPath = path.join(sourceRoot, "config.local.json");
  if (!existsSync(configPath)) {
    if (!existsSync(sourceConfigPath)) {
      throw new Error("bridge configuration is missing; run feishu-codex-bridge init or npm run setup first");
    }
    await copyFile(sourceConfigPath, configPath);
    await chmod(configPath, 0o600);
  }
  const installedConfig = JSON.parse(await readFile(configPath, "utf8"));
  const sourceConfig = existsSync(sourceConfigPath)
    ? JSON.parse(await readFile(sourceConfigPath, "utf8"))
    : installedConfig;
  const usesLegacyCodex = installedConfig.codexBin === "codex" || /\/\.nvm\/.*\/codex$/.test(installedConfig.codexBin ?? "");
  let changed = false;
  for (const key of [
    "workspaceAliases",
    "maxOfflineOperations",
    "timeZone",
    "scheduleCatchUpWindowMs",
    "attachmentsDir",
    "maxAttachmentBytes",
    "attachmentRetentionDays",
    "ffmpegBin"
  ]) {
    if (installedConfig[key] === undefined && sourceConfig[key] !== undefined) {
      installedConfig[key] = sourceConfig[key];
      changed = true;
    }
  }
  if (installedConfig.recentThreadLimit === undefined || installedConfig.recentThreadLimit === 5 || installedConfig.recentThreadLimit > 10) {
    installedConfig.recentThreadLimit = 10;
    changed = true;
  }
  for (const [alias, workspace] of Object.entries(installedConfig.workspaces ?? {})) {
    if (sourceConfig.workspaces?.[alias] === undefined && !existsSync(workspace)) {
      delete installedConfig.workspaces[alias];
      if (installedConfig.workspaceAliases) delete installedConfig.workspaceAliases[alias];
      changed = true;
      console.log(`removed unavailable workspace ${alias}: ${workspace}`);
    }
  }
  if (usesLegacyCodex) {
    installedConfig.codexBin = DESKTOP_CODEX_BIN;
    changed = true;
  }
  if (installedConfig.codexBin === DESKTOP_CODEX_BIN && installedConfig.desktopSyncEnabled !== true) {
    installedConfig.desktopSyncEnabled = true;
    changed = true;
  }
  if (installedConfig.codexBin === DESKTOP_CODEX_BIN && installedConfig.codexAppServerSocket !== defaultCodexAppServerSocket()) {
    installedConfig.codexAppServerSocket = defaultCodexAppServerSocket();
    changed = true;
  }
  const bundledLarkBin = path.join(releaseRoot, "node_modules", ".bin", "lark-cli");
  if (existsSync(bundledLarkBin) && installedConfig.larkBin !== bundledLarkBin) {
    installedConfig.larkBin = bundledLarkBin;
    changed = true;
  }
  if (changed) {
    await writeFile(configPath, `${JSON.stringify(installedConfig, null, 2)}\n`, { mode: 0o600 });
    await chmod(configPath, 0o600);
  }
  const installedState = path.join(dataRoot, "state.json");
  if (!existsSync(installedState) && existsSync(path.join(sourceRoot, "data", "state.json"))) {
    await copyFile(path.join(sourceRoot, "data", "state.json"), installedState);
    await chmod(installedState, 0o600);
  }

  const nodeBin = existsSync(process.execPath)
    ? process.execPath
    : execFileSync("which", ["node"], { encoding: "utf8" }).trim();
  const standardOut = path.join(logsRoot, "service.stdout.log");
  const standardError = path.join(logsRoot, "service.stderr.log");
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(nodeBin)}</string>
    <string>${xml(path.join(releaseRoot, "src", "bridge.mjs"))}</string>
  </array>
  <key>WorkingDirectory</key><string>${xml(releaseRoot)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>BRIDGE_CONFIG</key><string>${xml(configPath)}</string>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${xml(standardOut)}</string>
  <key>StandardErrorPath</key><string>${xml(standardError)}</string>
</dict>
</plist>
`;
  await writeFile(plistPath, plist, { mode: 0o600 });
  shell("plutil", ["-lint", plistPath]);
  enableDesktopDaemonEnvironment();
  shell(DESKTOP_CODEX_BIN, ["app-server", "daemon", "bootstrap"]);
  waitForOfficialDaemon();
  shell("launchctl", ["bootout", `${domain}/${LABEL}`], { allowFailure: true, capture: true });
  if (!waitForLaunchAgentState(false)) throw new Error(`${LABEL} did not stop within 5 seconds`);
  shell("launchctl", ["enable", `${domain}/${LABEL}`]);
  bootstrapLaunchAgent();
  console.log("bootstrapped official Codex app-server daemon");
  console.log(`installed ${LABEL}`);
  console.log(`release ${releaseRoot}`);
  console.log(`config  ${configPath}`);
  console.log(`logs    ${logsRoot}`);
  if (desktopWasRunning) {
    console.log("IMPORTANT: quit and reopen Codex Desktop once before sending the first Feishu task so it joins the shared app-server.");
  }
}

async function uninstall() {
  shell("launchctl", ["bootout", `${domain}/${LABEL}`], { allowFailure: true, capture: true });
  waitForLaunchAgentState(false);
  if (existsSync(plistPath)) {
    const disabledPath = `${plistPath}.disabled-${stamp()}`;
    await rename(plistPath, disabledPath);
    console.log(`launch agent disabled and preserved at ${disabledPath}`);
  }
  console.log("official Codex daemon was left running because it is shared with Codex Desktop");
  console.log(`configuration and data preserved at ${supportRoot}`);
}

function printServiceStatus(label) {
  const result = shell("launchctl", ["print", `${domain}/${label}`], { allowFailure: true, capture: true });
  if (result.status !== 0) {
    console.log(`${label}: not loaded`);
    return false;
  }
  const lines = result.stdout.split("\n").filter((line) => /state =|pid =|last exit code =|program =/.test(line));
  console.log(`${label}:\n${lines.join("\n").trim()}`);
  return true;
}

function status() {
  const result = shell(DESKTOP_CODEX_BIN, ["app-server", "daemon", "version"], { allowFailure: true, capture: true });
  let appServerReady = false;
  if (result.status === 0) {
    try {
      const daemon = JSON.parse(result.stdout);
      appServerReady = daemon.status === "running" && daemon.socketPath === defaultCodexAppServerSocket();
      console.log(`official Codex daemon:\nstatus = ${daemon.status}\nbackend = ${daemon.backend}\nversion = ${daemon.appServerVersion}\nsocket = ${daemon.socketPath}`);
    } catch {
      console.log("official Codex daemon: invalid status response");
    }
  } else {
    console.log(`official Codex daemon: unavailable\n${result.stderr.trim()}`);
  }
  const bridgeReady = printServiceStatus(LABEL);
  if (!appServerReady || !bridgeReady) process.exitCode = 1;
}

function restart() {
  enableDesktopDaemonEnvironment();
  shell(DESKTOP_CODEX_BIN, ["app-server", "daemon", "start"]);
  shell("launchctl", ["kickstart", "-k", `${domain}/${LABEL}`]);
  status();
}

async function logs() {
  await stat(logsRoot).catch(() => { throw new Error(`logs directory does not exist: ${logsRoot}`); });
  shell("tail", ["-n", "100", path.join(userHome, ".codex", "app-server-daemon", "app-server.stderr.log"), path.join(logsRoot, "service.stdout.log"), path.join(logsRoot, "service.stderr.log"), path.join(dataRoot, "bridge.jsonl")], { allowFailure: true });
}

async function showConfig() {
  console.log(await readFile(configPath, "utf8"));
}

const action = process.argv[2] ?? "status";
if (action === "install") await install();
else if (action === "uninstall") await uninstall();
else if (action === "status") status();
else if (action === "restart") restart();
else if (action === "logs") await logs();
else if (action === "config") await showConfig();
else {
  console.error("usage: npm run service -- install|status|restart|logs|config|uninstall");
  process.exitCode = 2;
}
