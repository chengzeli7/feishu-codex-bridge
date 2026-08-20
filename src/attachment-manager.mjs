import { randomBytes } from "node:crypto";
import { execFile as nodeExecFile } from "node:child_process";
import { mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const RESOURCE_MESSAGE_TYPES = new Set(["image", "file", "audio", "media", "video", "post"]);
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".heic", ".heif"]);

function safeMessageId(value) {
  if (!/^om_[a-z0-9_-]+$/i.test(value ?? "")) throw new Error("飞书附件消息 ID 无效");
  return value;
}

function collectResources(value, result = []) {
  if (!value || typeof value !== "object") return result;
  if (Array.isArray(value)) {
    for (const item of value) collectResources(item, result);
    return result;
  }
  if (Array.isArray(value.resources)) result.push(...value.resources);
  for (const nested of Object.values(value)) collectResources(nested, result);
  return result;
}

async function walkFiles(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  })) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await walkFiles(filePath));
    else if (entry.isFile()) result.push(filePath);
  }
  return result;
}

function inside(parent, child) {
  const relative = path.relative(parent, child);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export function eventHasResources(event) {
  return RESOURCE_MESSAGE_TYPES.has(event.message_type) ||
    /(?:img|file)_v?\d*_[a-z0-9_-]+|<(?:file|audio|media)\b/i.test(event.content ?? "");
}

export class AttachmentManager {
  constructor({
    root,
    maxBytes = 52_428_800,
    retentionDays = 7,
    ffmpegBin = "/opt/homebrew/bin/ffmpeg",
    execFile = nodeExecFile
  }) {
    this.root = path.resolve(root);
    this.maxBytes = maxBytes;
    this.retentionMs = retentionDays * 86_400_000;
    this.ffmpegBin = ffmpegBin;
    this.run = promisify(execFile);
  }

  async init({ protectedPaths = [] } = {}) {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await this.cleanup(Date.now(), protectedPaths);
  }

  async ingest(event, lark) {
    if (!eventHasResources(event)) return { attachments: [], transcript: null };
    const messageId = safeMessageId(event.message_id);
    const messageDirectory = path.join(this.root, messageId);
    await mkdir(messageDirectory, { recursive: true, mode: 0o700 });
    const result = await lark.downloadMessageResources(messageId, messageDirectory);
    const resources = collectResources(result);
    const discovered = await walkFiles(path.join(messageDirectory, "lark-im-resources"));
    const candidates = new Map();

    for (const resource of resources) {
      if (!resource?.local_path || resource.error) continue;
      const resolved = path.resolve(messageDirectory, resource.local_path);
      if (inside(messageDirectory, resolved)) {
        candidates.set(resolved, { type: resource.type, sizeBytes: resource.size_bytes });
      }
    }
    for (const filePath of discovered) {
      if (inside(messageDirectory, filePath) && !candidates.has(filePath)) candidates.set(filePath, {});
    }
    if (candidates.size === 0) throw new Error("飞书附件下载完成，但没有找到可读取的资源");

    const attachments = [];
    for (const [filePath, metadata] of candidates) {
      const info = await stat(filePath);
      if (info.size > this.maxBytes) {
        throw new Error(`附件 ${path.basename(filePath)} 超过 ${Math.floor(this.maxBytes / 1_048_576)} MiB 限制`);
      }
      const extension = path.extname(filePath).toLowerCase();
      attachments.push({
        path: filePath,
        name: path.basename(filePath),
        sizeBytes: info.size,
        kind: metadata.type === "image" || IMAGE_EXTENSIONS.has(extension) ? "image" :
          event.message_type === "audio" ? "audio" : "file"
      });
    }

    let transcript = null;
    if (event.message_type === "audio") {
      const audio = attachments.find((attachment) => attachment.kind === "audio") ?? attachments[0];
      transcript = await this.#transcribe(audio.path, messageDirectory, lark);
    }
    return { attachments, transcript };
  }

  async #transcribe(inputPath, messageDirectory, lark) {
    const pcmPath = path.join(messageDirectory, "voice-16k.pcm");
    try {
      await this.run(this.ffmpegBin, [
        "-hide_banner", "-loglevel", "error", "-y",
        "-i", inputPath,
        "-vn", "-acodec", "pcm_s16le", "-f", "s16le", "-ac", "1", "-ar", "16000",
        pcmPath
      ], { maxBuffer: 2 * 1024 * 1024 });
      const pcm = await readFile(pcmPath);
      const maxPcmBytes = 60 * 16_000 * 2;
      if (pcm.byteLength > maxPcmBytes) throw new Error("语音超过飞书 ASR 的 60 秒限制");
      const result = await lark.transcribePcm(pcm.toString("base64"), randomBytes(8).toString("hex"));
      const text = result?.recognition_text?.trim();
      if (!text) throw new Error("飞书 ASR 没有返回识别文本");
      return text;
    } catch (error) {
      throw new Error(`语音已安全保存在本机，但转写失败：${error.message}。请确认应用已开通 speech_to_text:speech 且租户版本支持 ASR`);
    } finally {
      await rm(pcmPath, { force: true }).catch(() => {});
    }
  }

  async cleanup(now = Date.now(), protectedPaths = []) {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const protectedDirectories = new Set(protectedPaths.map((filePath) => {
      const relative = path.relative(this.root, path.resolve(filePath));
      const [messageDirectory] = relative.split(path.sep);
      return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? messageDirectory : null;
    }).filter(Boolean));
    const entries = await readdir(this.root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^om_[a-z0-9_-]+$/i.test(entry.name)) continue;
      if (protectedDirectories.has(entry.name)) continue;
      const directory = path.join(this.root, entry.name);
      const info = await stat(directory);
      if (now - info.mtimeMs > this.retentionMs) await rm(directory, { recursive: true, force: true });
    }
  }
}
