import { EventEmitter } from "node:events";
import { spawn as nodeSpawn } from "node:child_process";
import net from "node:net";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";

const THREAD_STORE_RETRY_DELAYS_MS = [50, 100, 200, 400, 800];

function isTransientThreadStoreError(error) {
  return /rollout.*is empty|failed to read (?:canonical )?session metadata/i.test(error?.message ?? "");
}

function isArchivedThreadError(error) {
  return /(?:session|thread) .* is archived/i.test(error?.message ?? "");
}

function createUnixWebSocket(socketPath) {
  return new WebSocket("ws://localhost/rpc", {
    createConnection: () => net.createConnection(socketPath),
    perMessageDeflate: false
  });
}

export class CodexClient extends EventEmitter {
  constructor({ spawn = nodeSpawn, bin = "codex", socketPath = null, createWebSocket = createUnixWebSocket, requestTimeoutMs = 20_000 } = {}) {
    super();
    this.spawn = spawn;
    this.bin = bin;
    this.socketPath = socketPath;
    this.createWebSocket = createWebSocket;
    this.requestTimeoutMs = requestTimeoutMs;
    this.nextId = 1;
    this.pending = new Map();
    this.child = null;
    this.webSocket = null;
    this.ready = false;
  }

  async start() {
    if (this.child || this.webSocket) return;
    try {
      if (this.socketPath) await this.#startWebSocket();
      else this.#startStdio();
      await this.request("initialize", {
        clientInfo: { name: "feishu-codex-bridge", version: "0.1.3" },
        capabilities: { experimentalApi: true }
      });
      this.notify("initialized");
      this.ready = true;
      this.emit("ready");
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  #startStdio() {
    this.child = this.spawn(this.bin, ["app-server", "--listen", "stdio://"], {
      stdio: ["pipe", "pipe", "pipe"]
    });
    const child = this.child;

    createInterface({ input: child.stdout }).on("line", (line) => this.#handleLine(line));
    createInterface({ input: child.stderr }).on("line", (line) => this.emit("log", line));
    child.once("exit", (code, signal) => this.#handleExit(child, code, signal));
    child.once("error", (error) => this.#handleExit(child, null, null, error));
  }

  async #startWebSocket() {
    const webSocket = this.createWebSocket(this.socketPath);
    this.webSocket = webSocket;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Codex shared app-server connection timed out: ${this.socketPath}`));
      }, this.requestTimeoutMs);
      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onError = (error) => {
        cleanup();
        reject(error);
      };
      const cleanup = () => {
        clearTimeout(timer);
        webSocket.off("open", onOpen);
        webSocket.off("error", onError);
      };
      webSocket.once("open", onOpen);
      webSocket.once("error", onError);
    });
    webSocket.on("message", (data) => this.#handleLine(data.toString()));
    webSocket.once("close", (code, reason) => this.#handleWebSocketExit(webSocket, code, reason));
    webSocket.once("error", (error) => this.#handleWebSocketExit(webSocket, null, null, error));
  }

  request(method, params = {}) {
    if (!this.#isWritable()) {
      return Promise.reject(new Error("Codex app-server is not running"));
    }
    const id = this.nextId++;
    const payload = { id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex request timed out: ${method}`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      this.#write(payload);
    });
  }

  notify(method, params) {
    if (!this.#isWritable()) return;
    const payload = params === undefined ? { method } : { method, params };
    this.#write(payload);
  }

  respondError(id, message, code = -32_601) {
    if (!this.#isWritable()) return;
    this.#write({ id, error: { code, message } });
  }

  async listThreads(limit = 5, { archived = false, searchTerm = null } = {}) {
    const result = await this.request("thread/list", {
      limit,
      archived,
      ...(searchTerm ? { searchTerm } : {}),
      sortKey: "updated_at",
      sortDirection: "desc"
    });
    return result.data ?? [];
  }

  async searchThreads(searchTerm, limit = 10, { archived = false } = {}) {
    const result = await this.request("thread/search", {
      searchTerm,
      limit,
      archived,
      sortKey: "updated_at",
      sortDirection: "desc"
    });
    return result.data ?? [];
  }

  async readThread(threadId) {
    const result = await this.#retryThreadStoreRequest(() => this.request("thread/read", { threadId, includeTurns: true }));
    return result.thread;
  }

  async listThreadItems(threadId, {
    turnId = null,
    limit = 10,
    cursor = null,
    sortDirection = "desc"
  } = {}) {
    const result = await this.request("thread/items/list", {
      threadId,
      turnId,
      limit,
      cursor,
      sortDirection
    });
    return {
      items: result.data ?? [],
      nextCursor: result.nextCursor ?? null,
      backwardsCursor: result.backwardsCursor ?? null
    };
  }

  async createTask({
    cwd,
    prompt,
    name = null,
    effort = "default",
    attachments = [],
    clientUserMessageId = null,
    existingThreadId = null,
    onThreadStarted = null
  }) {
    const runtimeWorkspaceRoots = workspaceRoots(cwd, attachments);
    const started = existingThreadId ?
      { thread: await this.readThread(existingThreadId) } :
      await this.request("thread/start", {
        cwd,
        approvalPolicy: "never",
        runtimeWorkspaceRoots,
        ephemeral: false
      });
    const threadId = started.thread.id;
    if (onThreadStarted) await onThreadStarted(threadId);
    const turnParams = {
      threadId,
      input: userInput(prompt, attachments),
      approvalPolicy: "never",
      cwd,
      runtimeWorkspaceRoots,
      ...(clientUserMessageId ? { clientUserMessageId } : {})
    };
    if (effort && effort !== "default") turnParams.effort = effort;
    const turnResult = await this.request("turn/start", turnParams);
    if (name) {
      try {
        await this.renameThread(threadId, name);
      } catch (error) {
        this.emit("log", `Task started but automatic rename failed for ${threadId}: ${error.message}`);
      }
    }
    return { thread: { ...started.thread, ...(name ? { name } : {}) }, turn: turnResult.turn };
  }

  async sendMessage(threadId, text, thread = null, {
    clientUserMessageId = null,
    expectedTurnId = null,
    attachments = []
  } = {}) {
    let activeThread = thread;
    if (!activeThread || activeThread.status?.type === "notLoaded") {
      activeThread = await this.#resumeThreadForInput(threadId);
    }

    if (activeThread.status?.type === "active" && !activeThread.turns?.some((turn) => turn.status === "inProgress")) {
      activeThread = await this.readThread(threadId);
    }

    if (activeThread.status?.type === "active") {
      const activeTurnId = activeThread.turns?.findLast((turn) => turn.status === "inProgress")?.id ?? expectedTurnId;
      if (!activeTurnId) throw new Error("任务仍在同步当前回合，请刷新详情后重试");
      const result = await this.request("turn/steer", {
        threadId,
        expectedTurnId: activeTurnId,
        input: userInput(text, attachments)
      });
      return { id: result.turnId, status: "inProgress", items: [], steered: true };
    }

    const result = await this.request("turn/start", {
      threadId,
      input: userInput(text, attachments),
      approvalPolicy: "never",
      ...(activeThread.cwd ? {
        cwd: activeThread.cwd,
        runtimeWorkspaceRoots: workspaceRoots(activeThread.cwd, attachments)
      } : {}),
      ...(clientUserMessageId ? { clientUserMessageId } : {})
    });
    return result.turn;
  }

  async #resumeThreadForInput(threadId) {
    const resume = () => this.request("thread/resume", {
      threadId,
      approvalPolicy: "never"
    });
    try {
      return (await resume()).thread;
    } catch (error) {
      if (!isArchivedThreadError(error)) throw error;
      await this.unarchiveThread(threadId);
      return (await resume()).thread;
    }
  }

  async renameThread(threadId, name) {
    await this.#retryThreadStoreRequest(() => this.request("thread/name/set", { threadId, name }));
  }

  async archiveThread(threadId) {
    await this.request("thread/archive", { threadId });
  }

  async unarchiveThread(threadId) {
    const result = await this.request("thread/unarchive", { threadId });
    return result.thread;
  }

  async interruptThread(threadId, turnId) {
    await this.request("turn/interrupt", { threadId, turnId });
  }

  async unsubscribeThread(threadId) {
    return this.request("thread/unsubscribe", { threadId });
  }

  async stop() {
    const child = this.child;
    const webSocket = this.webSocket;
    this.child = null;
    this.webSocket = null;
    this.ready = false;
    this.#rejectPending(new Error("Codex app-server connection stopped"));
    if (child) {
      if (child.stdin.writable) child.stdin.end();
      child.kill("SIGTERM");
    }
    if (webSocket && webSocket.readyState < WebSocket.CLOSING) webSocket.close(1000, "bridge stopped");
  }

  #isWritable() {
    return Boolean(this.child?.stdin?.writable || this.webSocket?.readyState === WebSocket.OPEN);
  }

  #write(payload) {
    const serialized = JSON.stringify(payload);
    if (this.webSocket?.readyState === WebSocket.OPEN) this.webSocket.send(serialized);
    else this.child.stdin.write(`${serialized}\n`);
  }

  #handleLine(line) {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.emit("log", `Ignored non-JSON app-server output: ${line}`);
      return;
    }

    if (Object.hasOwn(message, "id") && (Object.hasOwn(message, "result") || Object.hasOwn(message, "error"))) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.method) {
      if (Object.hasOwn(message, "id")) {
        this.emit("serverRequest", message);
      } else {
        this.emit("notification", message);
        this.emit(message.method, message.params);
      }
    }
  }

  #handleExit(child, code, signal, error) {
    if (this.child !== child) return;
    const reason = error ?? new Error(`Codex app-server exited (code=${code}, signal=${signal})`);
    this.child = null;
    this.#finishExit(reason);
  }

  #handleWebSocketExit(webSocket, code, reason, error) {
    if (this.webSocket !== webSocket) return;
    const detail = reason?.toString() || "no reason";
    const failure = error ?? new Error(`Codex shared app-server disconnected (code=${code}, reason=${detail})`);
    this.webSocket = null;
    this.#finishExit(failure);
  }

  #finishExit(reason) {
    this.#rejectPending(reason);
    this.ready = false;
    this.emit("exit", reason);
  }

  #rejectPending(reason) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(reason);
    }
    this.pending.clear();
  }

  async #retryThreadStoreRequest(operation) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        const retryDelay = THREAD_STORE_RETRY_DELAYS_MS[attempt];
        if (retryDelay === undefined || !isTransientThreadStoreError(error)) throw error;
        await delay(retryDelay);
      }
    }
  }
}

function workspaceRoots(cwd, attachments = []) {
  return [...new Set([
    cwd,
    ...attachments.map((attachment) => pathDirectory(attachment.path)).filter(Boolean)
  ])];
}

function pathDirectory(filePath) {
  if (!filePath || typeof filePath !== "string") return null;
  const index = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  return index > 0 ? filePath.slice(0, index) : null;
}

export function userInput(text, attachments = []) {
  const fileAttachments = attachments.filter((attachment) => attachment.kind !== "image");
  const references = fileAttachments.length > 0 ?
    `\n\n飞书附件已保存到以下受限本机路径，请读取后完成任务：\n${fileAttachments.map((attachment) => `- ${attachment.name}: ${attachment.path}`).join("\n")}` :
    "";
  return [
    { type: "text", text: `${text}${references}`.trim() },
    ...attachments
      .filter((attachment) => attachment.kind === "image")
      .map((attachment) => ({ type: "localImage", path: attachment.path }))
  ];
}

export function latestAgentMessage(thread) {
  for (const turn of [...(thread.turns ?? [])].reverse()) {
    for (const item of [...(turn.items ?? [])].reverse()) {
      if (item.type === "agentMessage" && item.text?.trim()) return item.text.trim();
    }
  }
  return "";
}

export function latestCommand(thread) {
  for (const turn of [...(thread.turns ?? [])].reverse()) {
    for (const item of [...(turn.items ?? [])].reverse()) {
      if (item.type === "commandExecution") {
        return { command: item.command, status: item.status, exitCode: item.exitCode };
      }
    }
  }
  return null;
}

export function latestTurn(thread) {
  return thread.turns?.at(-1) ?? null;
}
