import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import path from "node:path";

const MAX_LOG_BYTES = 5 * 1024 * 1024;

function redact(value) {
  if (typeof value === "string") {
    return value
      .replace(/(app[_-]?secret|access[_-]?token|authorization)["'\s:=]+[^\s,"'}]+/gi, "$1=[REDACTED]")
      .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, "Bearer [REDACTED]");
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /secret|token|authorization/i.test(key) ? "[REDACTED]" : redact(item)]));
  }
  return value;
}

export class Logger {
  constructor(filePath) {
    this.filePath = filePath;
    this.startedAt = Date.now();
    this.lastError = null;
  }

  async init() {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const info = await stat(this.filePath);
      if (info.size >= MAX_LOG_BYTES) await rename(this.filePath, `${this.filePath}.1`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  info(message, fields = {}) {
    this.#write("info", message, fields);
  }

  warn(message, fields = {}) {
    this.#write("warn", message, fields);
  }

  error(message, fields = {}) {
    this.lastError = { message, at: Date.now() };
    this.#write("error", message, fields);
  }

  #write(level, message, fields) {
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      message: redact(message),
      ...redact(fields)
    };
    const line = `${JSON.stringify(entry)}\n`;
    appendFile(this.filePath, line, { mode: 0o600 }).catch((error) => {
      console.error(`[logger] ${error.message}`);
    });
    const output = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
    output(`[${level}] ${entry.message}`);
  }
}

export { redact };
