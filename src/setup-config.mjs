import path from "node:path";
import { DESKTOP_CODEX_BIN, defaultCodexAppServerSocket } from "./config.mjs";

const OPEN_ID_PATTERN = /^ou_[a-z0-9_-]+$/i;
const CHAT_ID_PATTERN = /^oc_[a-z0-9_-]+$/i;
const WORKSPACE_ALIAS_PATTERN = /^[a-z0-9][a-z0-9_-]*$/i;

export const PAIRING_PHRASE = "配对 Codex 助手";

export function pairingIdentity(event) {
  if (!event || event.chat_type !== "p2p") {
    throw new Error("配对消息必须来自飞书机器人私聊");
  }
  if (event.sender_type && event.sender_type !== "user") {
    throw new Error("配对消息必须由飞书用户发送");
  }
  if (String(event.content ?? "").trim() !== PAIRING_PHRASE) {
    throw new Error(`请发送完整配对口令：${PAIRING_PHRASE}`);
  }
  if (!OPEN_ID_PATTERN.test(event.sender_id ?? "")) {
    throw new Error("配对事件缺少有效的用户 open_id");
  }
  if (!CHAT_ID_PATTERN.test(event.chat_id ?? "")) {
    throw new Error("配对事件缺少有效的私聊 chat_id");
  }
  return { userId: event.sender_id, chatId: event.chat_id };
}

export function normalizeWorkspace({ alias, directory, aliases = [] }) {
  const normalizedAlias = String(alias ?? "").trim();
  const sourceDirectory = String(directory ?? "").trim();
  if (!WORKSPACE_ALIAS_PATTERN.test(normalizedAlias)) {
    throw new Error("项目代号只能包含英文字母、数字、下划线和连字符");
  }
  if (!path.isAbsolute(sourceDirectory)) {
    throw new Error(`项目 ${normalizedAlias} 必须使用绝对路径`);
  }
  const normalizedAliases = [...new Set(
    [normalizedAlias, ...aliases]
      .map((value) => String(value).trim())
      .filter(Boolean)
  )];
  return { alias: normalizedAlias, directory: path.resolve(sourceDirectory), aliases: normalizedAliases };
}

export function buildBridgeConfig({
  pairing,
  workspaceEntries,
  defaultWorkspace,
  larkBin,
  ffmpegBin = "/opt/homebrew/bin/ffmpeg",
  timeZone = "Asia/Shanghai"
}) {
  if (!pairing || !OPEN_ID_PATTERN.test(pairing.userId ?? "") || !CHAT_ID_PATTERN.test(pairing.chatId ?? "")) {
    throw new Error("缺少有效的飞书配对身份");
  }
  if (!Array.isArray(workspaceEntries) || workspaceEntries.length === 0) {
    throw new Error("至少需要配置一个项目目录");
  }

  const workspaces = {};
  const workspaceAliases = {};
  for (const entry of workspaceEntries.map(normalizeWorkspace)) {
    if (Object.hasOwn(workspaces, entry.alias)) throw new Error(`项目代号重复：${entry.alias}`);
    workspaces[entry.alias] = entry.directory;
    workspaceAliases[entry.alias] = entry.aliases;
  }
  if (!Object.hasOwn(workspaces, defaultWorkspace)) {
    throw new Error("默认项目必须引用已配置的项目代号");
  }

  return {
    allowedUserIds: [pairing.userId],
    allowedChatIds: [pairing.chatId],
    requireP2P: true,
    workspaces,
    workspaceAliases,
    defaultWorkspace,
    recentThreadLimit: 5,
    pollIntervalMs: 15_000,
    maxQueuedMessagesPerThread: 10,
    maxOfflineOperations: 50,
    timeZone,
    scheduleCatchUpWindowMs: 21_600_000,
    attachmentsDir: "./data/attachments",
    maxAttachmentBytes: 52_428_800,
    attachmentRetentionDays: 7,
    ffmpegBin,
    stateFile: "./data/state.json",
    eventSpoolDir: "./data/events",
    logFile: "./data/bridge.jsonl",
    lockFile: "./data/bridge.lock",
    codexBin: DESKTOP_CODEX_BIN,
    codexAppServerSocket: defaultCodexAppServerSocket(),
    desktopSyncEnabled: true,
    desktopAutoOpenEnabled: false,
    larkBin
  };
}
