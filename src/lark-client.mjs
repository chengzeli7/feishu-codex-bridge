import { EventEmitter } from "node:events";
import { spawn as nodeSpawn } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";

const QUIET_ENV = {
  LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1",
  LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1"
};

function eventDirectory(eventKey) {
  return eventKey.replaceAll(/[^a-z0-9_-]/gi, "_");
}

function parsedOutput(source) {
  const trimmed = source.trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    const lines = trimmed.split("\n").reverse();
    for (const line of lines) {
      try { return JSON.parse(line); } catch { /* keep looking */ }
    }
    throw new Error(trimmed);
  }
}

export class LarkClient extends EventEmitter {
  constructor({ spawn = nodeSpawn, bin = "lark-cli", spoolRoot = "./data/events", requestTimeoutMs = 30_000 } = {}) {
    super();
    this.spawn = spawn;
    this.bin = bin;
    this.spoolRoot = path.resolve(spoolRoot);
    this.requestTimeoutMs = requestTimeoutMs;
    this.consumers = new Map();
    this.spoolTimer = null;
    this.seenEventIds = new Set();
    this.inFlightIds = new Set();
    this.inFlightFiles = new Set();
    this.directoryEventKeys = new Map();
  }

  startConsumers(eventKeys = ["im.message.receive_v1", "card.action.trigger"]) {
    mkdirSync(this.spoolRoot, { recursive: true, mode: 0o700 });
    for (const eventKey of eventKeys) this.startConsumer(eventKey);
    if (!this.spoolTimer) this.spoolTimer = setInterval(() => this.#drainSpool(), 250);
  }

  startConsumer(eventKey = "im.message.receive_v1") {
    if (this.consumers.has(eventKey)) return;
    mkdirSync(this.spoolRoot, { recursive: true, mode: 0o700 });
    if (!this.spoolTimer) this.spoolTimer = setInterval(() => this.#drainSpool(), 250);
    const directory = eventDirectory(eventKey);
    this.directoryEventKeys.set(directory, eventKey);
    mkdirSync(path.join(this.spoolRoot, directory), { recursive: true, mode: 0o700 });
    const child = this.spawn(
      this.bin,
      ["event", "consume", eventKey, "--output-dir", directory, "--as", "bot"],
      {
        cwd: this.spoolRoot,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, ...QUIET_ENV }
      }
    );
    this.consumers.set(eventKey, child);

    createInterface({ input: child.stdout }).on("line", (line) => {
      if (!line.trim()) return;
      try {
        this.#emitEvent(eventKey, JSON.parse(line));
      } catch {
        this.emit("log", `Ignored non-JSON lark event: ${line}`);
      }
    });
    createInterface({ input: child.stderr }).on("line", (line) => {
      this.emit("log", line);
      if (line.includes(`[event] ready event_key=${eventKey}`)) this.emit("ready", eventKey);
    });
    child.once("exit", (code, signal) => {
      if (this.consumers.get(eventKey) !== child) return;
      this.consumers.delete(eventKey);
      this.#drainSpool();
      this.emit("exit", { eventKey, error: new Error(`lark event consumer exited (code=${code}, signal=${signal})`) });
    });
    child.once("error", (error) => {
      if (this.consumers.get(eventKey) === child) this.consumers.delete(eventKey);
      this.emit("exit", { eventKey, error });
    });
  }

  async replyMarkdown(messageId, text, idempotencyKey) {
    return this.#run([
      "im", "+messages-reply", "--message-id", messageId,
      "--markdown", text, "--as", "bot",
      "--idempotency-key", idempotencyKey.slice(0, 50)
    ]);
  }

  async replyCard(messageId, card, idempotencyKey) {
    return this.#run([
      "im", "+messages-reply", "--message-id", messageId,
      "--msg-type", "interactive", "--content", JSON.stringify(card), "--as", "bot",
      "--idempotency-key", idempotencyKey.slice(0, 50)
    ]);
  }

  async sendCard({ chatId, userId, card, idempotencyKey }) {
    if (Boolean(chatId) === Boolean(userId)) throw new Error("sendCard requires exactly one of chatId or userId");
    return this.#run([
      "im", "+messages-send", chatId ? "--chat-id" : "--user-id", chatId ?? userId,
      "--msg-type", "interactive", "--content", JSON.stringify(card), "--as", "bot",
      "--idempotency-key", idempotencyKey.slice(0, 50)
    ]);
  }

  async updateCard(token, card) {
    return this.#run([
      "api", "POST", "/open-apis/interactive/v1/card/update", "--as", "bot",
      "--data", JSON.stringify({ token, card })
    ]);
  }

  async downloadMessageResources(messageId, outputDirectory) {
    if (!/^om_[a-z0-9_-]+$/i.test(messageId ?? "")) throw new Error("invalid Feishu message ID");
    const cwd = path.resolve(outputDirectory);
    mkdirSync(cwd, { recursive: true, mode: 0o700 });
    return this.#run([
      "im", "+messages-mget",
      "--message-ids", messageId,
      "--download-resources",
      "--no-reactions",
      "--as", "bot",
      "--format", "json"
    ], { cwd, timeoutMs: 5 * 60_000 });
  }

  async transcribePcm(pcmBase64, fileId) {
    if (!/^[a-z0-9_]{16}$/i.test(fileId ?? "")) throw new Error("invalid ASR file ID");
    return this.#run([
      "api", "POST", "/open-apis/speech_to_text/v1/speech/file_recognize",
      "--as", "bot",
      "--data", "-"
    ], {
      timeoutMs: 90_000,
      input: JSON.stringify({
        speech: { speech: pcmBase64 },
        config: { file_id: fileId, format: "pcm", engine_type: "16k_auto" }
      })
    });
  }

  async reply(messageId, text, idempotencyKey) {
    return this.replyMarkdown(messageId, text, idempotencyKey);
  }

  async stop() {
    clearInterval(this.spoolTimer);
    this.spoolTimer = null;
    const consumers = [...this.consumers.values()];
    this.consumers.clear();
    for (const consumer of consumers) {
      if (consumer.stdin.writable) consumer.stdin.end();
      consumer.kill("SIGTERM");
    }
  }

  #drainSpool() {
    let directories;
    try {
      directories = readdirSync(this.spoolRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    } catch (error) {
      if (error.code !== "ENOENT") this.emit("log", `Failed to read lark event spool: ${error.message}`);
      return;
    }

    for (const entry of directories) {
      const eventKey = this.directoryEventKeys.get(entry.name) ?? entry.name;
      const directoryPath = path.join(this.spoolRoot, entry.name);
      let files;
      try {
        files = readdirSync(directoryPath).filter((file) => file.endsWith(".json")).sort();
      } catch (error) {
        if (error.code !== "ENOENT") this.emit("log", `Failed to read lark event spool: ${error.message}`);
        continue;
      }
      for (const file of files) {
        const filePath = path.join(directoryPath, file);
        if (this.inFlightFiles.has(filePath)) continue;
        try {
          const event = JSON.parse(readFileSync(filePath, "utf8"));
          this.#emitEvent(event.type ?? eventKey, event, filePath);
        } catch (error) {
          if (!(error instanceof SyntaxError) && error.code !== "ENOENT") {
            this.emit("log", `Failed to process lark event ${file}: ${error.message}`);
          }
        }
      }
    }
  }

  #emitEvent(eventKey, event, filePath = null) {
    const eventId = event.event_id ?? event.message_id ?? event.id;
    if (eventId && (this.seenEventIds.has(eventId) || this.inFlightIds.has(eventId))) {
      if (filePath && this.seenEventIds.has(eventId)) {
        try { unlinkSync(filePath); } catch (error) { if (error.code !== "ENOENT") throw error; }
      }
      return;
    }
    if (eventId) this.inFlightIds.add(eventId);
    if (filePath) this.inFlightFiles.add(filePath);
    let settled = false;
    const settle = (acknowledged) => {
      if (settled) return;
      settled = true;
      if (eventId) this.inFlightIds.delete(eventId);
      if (filePath) this.inFlightFiles.delete(filePath);
      if (!acknowledged) return;
      if (eventId) {
        this.seenEventIds.add(eventId);
        while (this.seenEventIds.size > 2_000) this.seenEventIds.delete(this.seenEventIds.values().next().value);
      }
      if (filePath) {
        try { unlinkSync(filePath); } catch (error) { if (error.code !== "ENOENT") this.emit("log", `Failed to acknowledge event: ${error.message}`); }
      }
    };
    const envelope = { eventKey, event, ack: () => settle(true), nack: () => settle(false) };
    this.emit("event", envelope);
    if (eventKey === "im.message.receive_v1") this.emit("message", event, envelope);
    if (eventKey === "card.action.trigger") this.emit("cardAction", event, envelope);
  }

  #run(args, { cwd, input, timeoutMs = this.requestTimeoutMs } = {}) {
    return new Promise((resolve, reject) => {
      const child = this.spawn(this.bin, args, {
        cwd,
        stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        env: { ...process.env, ...QUIET_ENV }
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const finish = (callback) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback();
      };
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        finish(() => reject(new Error(`lark-cli request timed out after ${timeoutMs}ms`)));
      }, timeoutMs);
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.once("error", (error) => finish(() => reject(error)));
      child.once("exit", (code) => {
        finish(() => {
          let parsed;
          try {
            parsed = parsedOutput(code === 0 ? stdout : stderr || stdout);
          } catch (error) {
            reject(error);
            return;
          }
          if (code !== 0 || parsed.ok === false) {
            reject(new Error(parsed.error?.hint ?? parsed.error?.message ?? (stderr.trim() || `lark-cli exited with code ${code}`)));
            return;
          }
          resolve(parsed.data ?? parsed);
        });
      });
      if (input !== undefined) child.stdin.end(input);
    });
  }
}
