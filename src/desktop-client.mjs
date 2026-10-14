import net from "node:net";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

const VERSIONS = { initialize: 0, "thread-owner-discovery": 1, "thread-follower-start-turn": 2 };
const MAX_FRAME_BYTES = 64 * 1024 * 1024;

export function desktopInput(input) {
  if (!Array.isArray(input)) throw new Error("Desktop input must be an array");
  return input.map((item) => {
    if (item.type !== "text") return item;
    if (typeof item.text !== "string") throw new Error("Desktop text input must be a string");
    const elements = item.text_elements ?? [];
    if (!Array.isArray(elements)) throw new Error("Desktop text_elements must be an array");
    // Desktop renders the optimistic user message before the app-server can
    // normalize it. Its navigation/parser reads text_elements.length directly.
    return { ...item, text_elements: elements };
  });
}

export function desktopBusy(state) {
  return state?.threadRuntimeStatus?.type !== "idle" || state.requests?.length > 0 ||
    state.resumeState !== "resumed" || (state.unconfirmedTurnSubmissions?.length ?? 0) > 0;
}

// A follower only: never resume a thread or acquire its app-server writer.
export class DesktopClient extends EventEmitter {
  constructor({ socketPath, timeoutMs = 5000, connect = net.createConnection, wakeThread = null }) {
    super();
    this.socketPath = socketPath;
    this.timeoutMs = timeoutMs;
    this.connect = connect;
    this.wakeThread = wakeThread;
    this.clientId = "initializing-client";
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);
    this.socket = null;
  }

  async start() {
    this.socket = this.connect(this.socketPath);
    this.socket.on("data", (chunk) => this.receive(chunk));
    this.socket.on("error", (error) => this.fail(error));
    this.socket.on("close", () => this.fail(new Error("Desktop connection closed")));
    const reply = await this.request("initialize", { clientType: "feishu-bridge-assistant" });
    this.clientId = reply.result.clientId;
  }

  write(message) {
    if (!this.socket || this.socket.destroyed) throw new Error("Desktop is not connected");
    const body = Buffer.from(JSON.stringify(message));
    if (body.length > MAX_FRAME_BYTES) throw new Error("Desktop IPC frame too large");
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length);
    this.socket.write(Buffer.concat([header, body]));
  }

  request(method, params, targetClientId) {
    const version = VERSIONS[method];
    if (version === undefined) return Promise.reject(new Error("Unsupported Desktop method"));
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`Desktop request timed out: ${method}`));
      }, this.timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      try {
        this.write({ type: "request", requestId, sourceClientId: this.clientId, version,
          method, params, targetClientId, timeoutMs: this.timeoutMs });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(error);
      }
    });
  }

  receive(chunk) {
    try {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      while (this.buffer.length >= 4) {
        const size = this.buffer.readUInt32LE(0);
        if (!size || size > MAX_FRAME_BYTES) throw new Error("Invalid Desktop IPC frame length");
        if (this.buffer.length < size + 4) return;
        const message = JSON.parse(this.buffer.subarray(4, size + 4).toString());
        this.buffer = this.buffer.subarray(size + 4);
        if (message.type === "response") {
          const pending = this.pending.get(message.requestId);
          if (!pending) continue;
          this.pending.delete(message.requestId);
          clearTimeout(pending.timer);
          if (message.resultType === "success") pending.resolve(message);
          else pending.reject(new Error(message.error || "Desktop request failed"));
        } else if (message.type === "client-discovery-request") {
          this.write({ type: "client-discovery-response", requestId: message.requestId,
            response: { canHandle: false } });
        } else if (message.type === "broadcast") {
          this.emit("broadcast", message);
        }
      }
    } catch (error) { this.fail(error); this.socket?.destroy(); }
  }

  async snapshot(threadId) {
    try { return await this.readSnapshot(threadId); }
    catch (error) {
      if (!this.wakeThread) throw error;
      // Preparing a task never submits user input or takes its writer. Wake once
      // per request, with a process-wide cooldown, instead of endless polling.
      await this.wakeThread(threadId);
      let lastError = error;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await delay(250 * (attempt + 1));
        try { return await this.readSnapshot(threadId); } catch (retryError) { lastError = retryError; }
      }
      throw lastError;
    }
  }

  async readSnapshot(threadId) {
    const owner = await this.request("thread-owner-discovery", { hostId: "local", conversationId: threadId });
    const ownerId = owner.handledByClientId;
    const state = await new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); this.off("broadcast", onBroadcast); this.off("disconnect", onError); };
      const onError = (error) => { cleanup(); reject(error); };
      const onBroadcast = (message) => {
        if (message.sourceClientId !== ownerId || message.method !== "thread-stream-state-changed" || message.version !== 11) return;
        const params = message.params;
        if (params?.hostId !== "local" || params.conversationId !== threadId || params.change?.type !== "snapshot") return;
        cleanup(); resolve(params.change.conversationState);
      };
      const timer = setTimeout(() => onError(new Error("Desktop snapshot timed out")), this.timeoutMs);
      this.on("broadcast", onBroadcast);
      this.on("disconnect", onError);
      try { this.follow(threadId, ownerId, true); } catch (error) { onError(error); }
    });
    return { ownerId, state };
  }

  follow(threadId, ownerId, following) {
    this.write({ type: "broadcast", sourceClientId: this.clientId, version: 1,
      method: "thread-stream-following-changed", targetClientIds: [ownerId],
      params: { conversationId: threadId, hostId: "local", following } });
  }

  async startTurn(threadId, text, clientUserMessageId, ownerId, { input, approvalPolicy } = {}) {
    let normalized;
    try { normalized = desktopInput(input ?? [{ type: "text", text }]); }
    catch (error) { throw Object.assign(error, { requestOutcome: "not_sent" }); }
    const reply = await this.request("thread-follower-start-turn", {
      conversationId: threadId,
      turnStart: { request: { threadId, clientUserMessageId,
        input: normalized,
        ...(approvalPolicy ? { approvalPolicy } : {}) }, context: { inheritThreadSettings: true } }
    }, ownerId);
    return reply.result?.result?.turn ?? reply.result?.turn;
  }

  fail(error) {
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); }
    this.pending.clear();
    this.emit("disconnect", error);
  }

  stop() {
    this.fail(new Error("Desktop client stopped"));
    this.socket?.destroy();
    this.socket = null;
    this.buffer = Buffer.alloc(0);
  }
}

export class DesktopContinuation {
  constructor({ socketPath, createClient = (options) => new DesktopClient(options), wakeThread = null }) {
    Object.assign(this, { socketPath, createClient, wakeThread });
  }

  async sendMessage(threadId, text, { input, clientUserMessageId, approvalPolicy = "never" } = {}) {
    const client = this.createClient({ socketPath: this.socketPath, timeoutMs: 3000, wakeThread: this.wakeThread });
    let submitting = false;
    try {
      await client.start();
      let snapshot;
      try { snapshot = await client.snapshot(threadId); }
      catch (error) {
        throw new Error(`无法连接此任务的 Desktop 持有者，请在 Codex 中打开该任务后重试：${error.message}`);
      }
      const { state, ownerId } = snapshot;
      if (desktopBusy(state)) {
        throw Object.assign(new Error("Codex Desktop 当前回合仍在运行或等待处理，消息继续排队"), { code: "QUEUE_TURN_ACTIVE" });
      }
      submitting = true;
      const turn = await client.startTurn(threadId, text, clientUserMessageId, ownerId, { input, approvalPolicy });
      if (!turn?.id) throw new Error("Desktop did not confirm a turn ID");
      return { ...turn, desktopOwned: true };
    } catch (error) {
      // Once start has been written, timeout/disconnect is never safe to replay.
      error.requestOutcome ??= submitting ? "unknown" : "not_sent";
      error.requestMethod ??= submitting ? "turn/start" : "desktop/prepare";
      throw error;
    } finally { client.stop(); }
  }
}
