import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const DEFAULTS = {
  allowedUserIds: [],
  allowedChatIds: [],
  requireP2P: true,
  workspaces: {},
  workspaceAliases: {},
  defaultWorkspace: null,
  recentThreadLimit: 5,
  pollIntervalMs: 15_000,
  maxQueuedMessagesPerThread: 10,
  maxOfflineOperations: 50,
  timeZone: "Asia/Shanghai",
  scheduleCatchUpWindowMs: 21_600_000,
  attachmentsDir: "./data/attachments",
  maxAttachmentBytes: 52_428_800,
  attachmentRetentionDays: 7,
  ffmpegBin: "/opt/homebrew/bin/ffmpeg",
  stateFile: "./data/state.json",
  eventSpoolDir: "./data/events",
  logFile: "./data/bridge.jsonl",
  lockFile: "./data/bridge.lock",
  codexBin: "codex",
  codexAppServerSocket: null,
  desktopSyncEnabled: false,
  desktopAutoOpenEnabled: false,
  larkBin: "lark-cli"
};

export const DESKTOP_CODEX_BIN = "/Applications/ChatGPT.app/Contents/Resources/codex";

export async function loadConfig(configPath = process.env.BRIDGE_CONFIG ?? "./config.local.json") {
  const absolutePath = path.resolve(configPath);
  const raw = JSON.parse(await readFile(absolutePath, "utf8"));
  const config = { ...DEFAULTS, ...raw };

  if (!Array.isArray(config.allowedUserIds) || config.allowedUserIds.length !== 1) {
    throw new Error("allowedUserIds must contain exactly one Feishu open_id in single-user mode");
  }
  if (!Array.isArray(config.allowedChatIds)) {
    throw new Error("allowedChatIds must be an array");
  }
  if (typeof config.requireP2P !== "boolean") {
    throw new Error("requireP2P must be a boolean");
  }
  if (!config.workspaces || typeof config.workspaces !== "object" || Array.isArray(config.workspaces)) {
    throw new Error("workspaces must be an object of alias -> absolute path");
  }
  if (Object.keys(config.workspaces).length === 0) {
    throw new Error("workspaces must contain at least one allowed project");
  }
  for (const [alias, workspacePath] of Object.entries(config.workspaces)) {
    if (!/^[a-z0-9][a-z0-9_-]*$/i.test(alias)) {
      throw new Error(`invalid workspace alias: ${alias}`);
    }
    if (typeof workspacePath !== "string" || !path.isAbsolute(workspacePath)) {
      throw new Error(`workspace ${alias} must be an absolute path`);
    }
  }
  if (!config.workspaceAliases || typeof config.workspaceAliases !== "object" || Array.isArray(config.workspaceAliases)) {
    throw new Error("workspaceAliases must be an object of workspace alias -> string[]");
  }
  for (const [alias, aliases] of Object.entries(config.workspaceAliases)) {
    if (!Object.hasOwn(config.workspaces, alias) || !Array.isArray(aliases) || aliases.some((value) => typeof value !== "string" || !value.trim())) {
      throw new Error(`workspaceAliases.${alias} must be a non-empty string array for a configured workspace`);
    }
  }
  if (config.defaultWorkspace !== null && !Object.hasOwn(config.workspaces, config.defaultWorkspace)) {
    throw new Error("defaultWorkspace must reference a configured workspace alias");
  }
  if (!Number.isInteger(config.recentThreadLimit) || config.recentThreadLimit < 1 || config.recentThreadLimit > 5) {
    throw new Error("recentThreadLimit must be an integer between 1 and 5");
  }
  if (!Number.isInteger(config.pollIntervalMs) || config.pollIntervalMs < 5_000) {
    throw new Error("pollIntervalMs must be an integer >= 5000");
  }
  if (!Number.isInteger(config.maxQueuedMessagesPerThread) || config.maxQueuedMessagesPerThread < 1 || config.maxQueuedMessagesPerThread > 50) {
    throw new Error("maxQueuedMessagesPerThread must be an integer between 1 and 50");
  }
  if (!Number.isInteger(config.maxOfflineOperations) || config.maxOfflineOperations < 1 || config.maxOfflineOperations > 200) {
    throw new Error("maxOfflineOperations must be an integer between 1 and 200");
  }
  try {
    new Intl.DateTimeFormat("en", { timeZone: config.timeZone }).format();
  } catch {
    throw new Error(`invalid timeZone: ${config.timeZone}`);
  }
  if (!Number.isInteger(config.scheduleCatchUpWindowMs) || config.scheduleCatchUpWindowMs < 0) {
    throw new Error("scheduleCatchUpWindowMs must be a non-negative integer");
  }
  if (!Number.isInteger(config.maxAttachmentBytes) || config.maxAttachmentBytes < 1_048_576 || config.maxAttachmentBytes > 104_857_600) {
    throw new Error("maxAttachmentBytes must be between 1 MiB and 100 MiB");
  }
  if (!Number.isInteger(config.attachmentRetentionDays) || config.attachmentRetentionDays < 1 || config.attachmentRetentionDays > 30) {
    throw new Error("attachmentRetentionDays must be an integer between 1 and 30");
  }
  if (typeof config.ffmpegBin !== "string" || !config.ffmpegBin) throw new Error("ffmpegBin must be a non-empty string");
  if (typeof config.codexBin !== "string" || !config.codexBin) throw new Error("codexBin must be a non-empty string");
  if (config.codexAppServerSocket !== null && (typeof config.codexAppServerSocket !== "string" || !path.isAbsolute(config.codexAppServerSocket))) {
    throw new Error("codexAppServerSocket must be null or an absolute path");
  }
  if (typeof config.desktopSyncEnabled !== "boolean") throw new Error("desktopSyncEnabled must be a boolean");
  if (typeof config.desktopAutoOpenEnabled !== "boolean") throw new Error("desktopAutoOpenEnabled must be a boolean");
  if (config.desktopSyncEnabled && process.platform === "darwin" && path.resolve(config.codexBin) !== DESKTOP_CODEX_BIN) {
    throw new Error(`desktopSyncEnabled requires the Codex Desktop runtime: ${DESKTOP_CODEX_BIN}`);
  }
  if (config.desktopSyncEnabled && config.codexAppServerSocket !== null && path.resolve(config.codexAppServerSocket) !== defaultCodexAppServerSocket()) {
    throw new Error(`Desktop shared sync requires the default Codex app-server socket: ${defaultCodexAppServerSocket()}`);
  }
  if (typeof config.larkBin !== "string" || !config.larkBin) throw new Error("larkBin must be a non-empty string");

  return {
    ...config,
    configPath: absolutePath,
    stateFile: path.resolve(path.dirname(absolutePath), config.stateFile),
    eventSpoolDir: path.resolve(path.dirname(absolutePath), config.eventSpoolDir),
    attachmentsDir: path.resolve(path.dirname(absolutePath), config.attachmentsDir),
    logFile: path.resolve(path.dirname(absolutePath), config.logFile),
    lockFile: path.resolve(path.dirname(absolutePath), config.lockFile)
  };
}

export function defaultCodexAppServerSocket() {
  return path.join(os.homedir(), ".codex", "app-server-control", "app-server-control.sock");
}
