import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const EMPTY_STATE = {
  version: 3,
  chats: {},
  watches: {},
  queues: {},
  messageBindings: {},
  pendingIntents: {},
  operations: {},
  schedules: {},
  notifications: { mutedUntil: null },
  processedMessageIds: [],
  processedEventIds: []
};

function migrate(parsed) {
  if (!parsed || typeof parsed !== "object") return structuredClone(EMPTY_STATE);
  const chats = Object.fromEntries(Object.entries(parsed.chats ?? {}).map(([chatId, chat]) => [
    chatId,
    {
      ...chat,
      ...(chat.focusedThreadId || !chat.selectedThreadId ? {} : {
        focusedThreadId: chat.selectedThreadId,
        focusedAt: chat.focusedAt ?? Date.now()
      })
    }
  ]));
  return {
    ...structuredClone(EMPTY_STATE),
    ...parsed,
    version: 3,
    chats,
    watches: parsed.watches ?? {},
    queues: parsed.queues ?? {},
    messageBindings: parsed.messageBindings ?? {},
    pendingIntents: parsed.pendingIntents ?? {},
    operations: Object.fromEntries(Object.entries(parsed.operations ?? {}).map(([id, operation]) => [
      id,
      operation.status === "dispatching" ? { ...operation, status: "queued" } : operation
    ])),
    schedules: parsed.schedules ?? {},
    notifications: { ...EMPTY_STATE.notifications, ...(parsed.notifications ?? {}) },
    processedMessageIds: parsed.processedMessageIds ?? [],
    processedEventIds: parsed.processedEventIds ?? []
  };
}

export class StateStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.state = structuredClone(EMPTY_STATE);
    this.processing = new Set();
    this.saveChain = Promise.resolve();
  }

  async load() {
    try {
      this.state = migrate(JSON.parse(await readFile(this.filePath, "utf8")));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    return this.state;
  }

  hasProcessed(id) {
    return this.processing.has(id) ||
      this.state.processedMessageIds.includes(id) ||
      this.state.processedEventIds.includes(id);
  }

  beginProcessing(id) {
    if (!id || this.hasProcessed(id)) return false;
    this.processing.add(id);
    return true;
  }

  async finishProcessing(id, kind = "message") {
    this.processing.delete(id);
    const key = kind === "event" ? "processedEventIds" : "processedMessageIds";
    this.state[key].push(id);
    this.state[key] = this.state[key].slice(-2_000);
    await this.save();
  }

  cancelProcessing(id) {
    this.processing.delete(id);
  }

  recordChat(chatId, { chatType, senderId } = {}) {
    const chat = this.state.chats[chatId] ?? {};
    this.state.chats[chatId] = {
      ...chat,
      ...(chatType ? { chatType } : {}),
      ...(senderId ? { senderId } : {}),
      lastSeenAt: Date.now()
    };
  }

  setRecentThreads(chatId, threadIds) {
    const chat = this.state.chats[chatId] ?? {};
    this.state.chats[chatId] = { ...chat, recentThreadIds: threadIds };
  }

  selectThread(chatId, threadId) {
    const chat = this.state.chats[chatId] ?? {};
    this.state.chats[chatId] = {
      ...chat,
      selectedThreadId: threadId,
      focusedThreadId: threadId,
      focusedAt: Date.now()
    };
  }

  getChat(chatId) {
    return this.state.chats[chatId] ?? {};
  }

  bindMessage(messageId, { threadId, chatId, kind = "task" }) {
    if (!messageId || !threadId) return;
    this.state.messageBindings[messageId] = { messageId, threadId, chatId, kind, createdAt: Date.now() };
    const entries = Object.entries(this.state.messageBindings)
      .sort((left, right) => Number(left[1].createdAt) - Number(right[1].createdAt));
    for (const [id] of entries.slice(0, Math.max(0, entries.length - 2_000))) delete this.state.messageBindings[id];
  }

  getMessageBinding(messageId) {
    return messageId ? this.state.messageBindings[messageId] ?? null : null;
  }

  createPendingIntent(intent) {
    const entry = {
      id: randomUUID(),
      ...intent,
      createdAt: Date.now()
    };
    this.state.pendingIntents[entry.id] = entry;
    return entry;
  }

  getPendingIntent(id) {
    return this.state.pendingIntents[id] ?? null;
  }

  consumePendingIntent(id) {
    const entry = this.state.pendingIntents[id] ?? null;
    delete this.state.pendingIntents[id];
    return entry;
  }

  prunePendingIntents(maxAgeMs = 24 * 60 * 60_000) {
    const cutoff = Date.now() - maxAgeMs;
    for (const [id, entry] of Object.entries(this.state.pendingIntents)) {
      if (Number(entry.createdAt) < cutoff) delete this.state.pendingIntents[id];
    }
  }

  watchThread(threadId, watch) {
    this.state.watches[threadId] = {
      ...(this.state.watches[threadId] ?? {}),
      ...watch,
      threadId,
      notified: false,
      updatedAt: Date.now()
    };
  }

  unwatchThread(threadId) {
    delete this.state.watches[threadId];
  }

  getWatch(threadId) {
    return this.state.watches[threadId];
  }

  isWatching(threadId) {
    return Boolean(this.state.watches[threadId] && !this.state.watches[threadId].notified);
  }

  activeWatches() {
    return Object.values(this.state.watches).filter((watch) => !watch.notified);
  }

  markNotified(threadId) {
    const watch = this.state.watches[threadId];
    if (watch) {
      watch.notified = true;
      watch.updatedAt = Date.now();
    }
  }

  enqueue(threadId, item, limit = 10) {
    const queue = this.state.queues[threadId] ?? [];
    if (queue.length >= limit) throw new Error(`该任务最多保留 ${limit} 条排队消息`);
    const entry = {
      id: randomUUID(),
      threadId,
      text: item.text,
      chatId: item.chatId,
      sourceMessageId: item.sourceMessageId,
      senderId: item.senderId,
      attachments: item.attachments ?? [],
      createdAt: Date.now(),
      status: "queued"
    };
    queue.push(entry);
    this.state.queues[threadId] = queue;
    return entry;
  }

  queuedFor(threadId) {
    return [...(this.state.queues[threadId] ?? [])].filter((item) => item.status === "queued");
  }

  allQueued() {
    return Object.values(this.state.queues).flat().filter((item) => item.status === "queued");
  }

  enqueueOperation(operation, limit = 50) {
    const pending = this.pendingOperations();
    if (pending.length >= limit) throw new Error(`离线操作队列最多保留 ${limit} 条`);
    const id = operation.id ?? randomUUID();
    const existing = this.state.operations[id];
    if (existing) return existing;
    const entry = {
      id,
      ...operation,
      status: "queued",
      attempts: 0,
      createdAt: Date.now(),
      retryAt: 0
    };
    this.state.operations[id] = entry;
    return entry;
  }

  pendingOperations(now = Date.now()) {
    return Object.values(this.state.operations)
      .filter((operation) => operation.status === "queued" && Number(operation.retryAt ?? 0) <= now)
      .sort((left, right) => Number(left.createdAt) - Number(right.createdAt));
  }

  allOperations() {
    return Object.values(this.state.operations)
      .filter((operation) => operation.status === "queued" || operation.status === "dispatching" || operation.status === "failed");
  }

  updateOperation(id, patch) {
    const operation = this.state.operations[id];
    if (!operation) return null;
    Object.assign(operation, patch, { updatedAt: Date.now() });
    return operation;
  }

  completeOperation(id) {
    const operation = this.state.operations[id] ?? null;
    delete this.state.operations[id];
    return operation;
  }

  failOperation(id, error, { terminal = false } = {}) {
    const operation = this.state.operations[id];
    if (!operation) return null;
    operation.attempts = Number(operation.attempts ?? 0) + 1;
    operation.lastError = error?.message ?? String(error);
    operation.status = terminal || operation.attempts >= 5 ? "failed" : "queued";
    operation.retryAt = Date.now() + Math.min(60_000, 2_000 * 2 ** Math.min(operation.attempts, 5));
    operation.updatedAt = Date.now();
    return operation;
  }

  addSchedule(schedule) {
    const entry = {
      id: schedule.id ?? randomUUID(),
      ...schedule,
      status: schedule.status ?? "active",
      createdAt: schedule.createdAt ?? Date.now(),
      updatedAt: Date.now()
    };
    this.state.schedules[entry.id] = entry;
    return entry;
  }

  getSchedule(id) {
    return this.state.schedules[id] ?? null;
  }

  schedulesForChat(chatId, { includeCanceled = false } = {}) {
    return Object.values(this.state.schedules)
      .filter((schedule) => schedule.chatId === chatId && (includeCanceled || schedule.status !== "canceled"))
      .sort((left, right) => Number(right.createdAt) - Number(left.createdAt));
  }

  updateSchedule(id, patch) {
    const schedule = this.state.schedules[id];
    if (!schedule) return null;
    Object.assign(schedule, patch, { updatedAt: Date.now() });
    return schedule;
  }

  cancelScheduleOperations(scheduleId) {
    let count = 0;
    for (const [id, operation] of Object.entries(this.state.operations)) {
      if (operation.scheduleId !== scheduleId || operation.status === "dispatching") continue;
      delete this.state.operations[id];
      count += 1;
    }
    return count;
  }

  setRecentSchedules(chatId, ids) {
    const chat = this.state.chats[chatId] ?? {};
    this.state.chats[chatId] = { ...chat, recentScheduleIds: ids };
  }

  cancelQueue(threadId) {
    const queue = this.queuedFor(threadId);
    delete this.state.queues[threadId];
    return queue;
  }

  shiftQueue(threadId) {
    const queue = this.state.queues[threadId] ?? [];
    const index = queue.findIndex((item) => item.status === "queued");
    if (index < 0) return null;
    const [entry] = queue.splice(index, 1);
    if (queue.length === 0) delete this.state.queues[threadId];
    else this.state.queues[threadId] = queue;
    return entry;
  }

  setMutedUntil(timestamp) {
    this.state.notifications.mutedUntil = timestamp;
  }

  mutedUntil() {
    return this.state.notifications.mutedUntil;
  }

  isMuted(now = Date.now()) {
    return Number(this.state.notifications.mutedUntil ?? 0) > now;
  }

  async save() {
    const snapshot = `${JSON.stringify(this.state, null, 2)}\n`;
    this.saveChain = this.saveChain.catch(() => {}).then(async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      const temporaryPath = `${this.filePath}.tmp`;
      await writeFile(temporaryPath, snapshot, { mode: 0o600 });
      await rename(temporaryPath, this.filePath);
    });
    return this.saveChain;
  }

  async flush() {
    await this.saveChain;
  }
}
