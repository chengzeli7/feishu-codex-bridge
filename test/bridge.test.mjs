import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { Bridge } from "../src/bridge.mjs";

class FakeCodex extends EventEmitter {
  constructor(thread) {
    super();
    this.thread = thread;
    this.ready = true;
    this.created = [];
    this.sent = [];
    this.unsubscribed = [];
    this.readCount = 0;
  }
  async start() { this.ready = true; queueMicrotask(() => this.emit("ready")); }
  async stop() { this.ready = false; }
  async listThreads() { return this.thread ? [this.thread] : []; }
  async searchThreads() { return this.thread ? [this.thread] : []; }
  async readThread() { this.readCount += 1; return this.thread; }
  async listThreadItems(_threadId, { turnId, limit = 10, cursor = null } = {}) {
    const turn = this.thread?.turns?.find((item) => item.id === turnId);
    const items = [...(turn?.items ?? [])].reverse();
    const offset = cursor?.startsWith("cursor-") ? Number(cursor.slice(7)) : 0;
    const data = items.slice(offset, offset + limit);
    const nextOffset = offset + data.length;
    return {
      items: data,
      nextCursor: nextOffset < items.length ? `cursor-${nextOffset}` : null,
      backwardsCursor: null
    };
  }
  async sendMessage(threadId, text, thread, options) {
    this.sent.push({ threadId, text, thread, options });
    return { id: "turn-remote", status: "inProgress", items: [] };
  }
  async createTask(input) {
    this.created.push(input);
    const thread = { id: "019f0000-0000-7000-8000-00000000c001", name: input.name, cwd: input.cwd, status: { type: "active" }, turns: [] };
    const turn = { id: "019f-created-turn", status: "inProgress", items: [] };
    this.thread = thread;
    return { thread, turn };
  }
  async renameThread(_threadId, name) { this.thread.name = name; }
  async archiveThread() {}
  async unarchiveThread() {}
  async interruptThread() {}
  async unsubscribeThread(threadId) {
    this.unsubscribed.push(threadId);
    return { status: "unsubscribed" };
  }
  respondError() {}
}

class FakeLark extends EventEmitter {
  constructor() {
    super();
    this.replies = [];
    this.updates = [];
  }
  startConsumer(eventKey) { queueMicrotask(() => this.emit("ready", eventKey)); }
  async stop() {}
  async replyCard(messageId, content, idempotencyKey, options) {
    const result = { message_id: `om_bot_${this.replies.length + 1}` };
    this.replies.push({ type: "card", messageId, content, idempotencyKey, result, options });
    return result;
  }
  async replyMarkdown(messageId, content, idempotencyKey, options) {
    const result = { message_id: `om_bot_${this.replies.length + 1}` };
    this.replies.push({ type: "markdown", messageId, content, idempotencyKey, result, options });
    return result;
  }
  async updateCard(token, content) { this.updates.push({ token, content }); }
  async sendCard(payload) {
    const result = { message_id: `om_bot_${this.replies.length + 1}` };
    this.replies.push({ type: "send", ...payload, result });
    return result;
  }
}

class FakeLogger {
  constructor() { this.lastError = null; }
  async init() {}
  info() {}
  warn() {}
  error(message) { this.lastError = { message }; }
}

class FakeLock {
  async acquire() {}
  async release() {}
}

function waitFor(predicate, timeoutMs = 1000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error("timed out"));
      setTimeout(tick, 5);
    };
    tick();
  });
}

function messageEnvelope(overrides = {}) {
  let acknowledged = false;
  return {
    eventKey: "im.message.receive_v1",
    event: {
      event_id: `event-${Math.random()}`,
      sender_type: "user",
      sender_id: "ou_allowed",
      chat_type: "p2p",
      chat_id: "oc_chat",
      message_id: `om_${Math.random()}`,
      content: "任务",
      ...overrides
    },
    ack() { acknowledged = true; },
    nack() {},
    get acknowledged() { return acknowledged; }
  };
}

function cardActionEnvelope({ action, value = {}, messageId = "om_bot_1", token = "card-token" } = {}) {
  let acknowledged = false;
  return {
    eventKey: "card.action.trigger",
    event: {
      event_id: `event-action-${Math.random()}`,
      operator_id: "ou_allowed",
      chat_id: "oc_chat",
      message_id: messageId,
      token,
      action_value: { action, ...value },
      form_value: {}
    },
    ack() { acknowledged = true; },
    nack() {},
    get acknowledged() { return acknowledged; }
  };
}

async function makeBridge(thread, { pollIntervalMs = 60_000, codexReady = true, codexDaemon, startOrder, configOverrides = {} } = {}) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-feishu-bridge-"));
  const codex = new FakeCodex(thread);
  codex.ready = codexReady;
  if (startOrder) {
    const start = codex.start.bind(codex);
    codex.start = async () => {
      startOrder.push("codex");
      return start();
    };
  }
  const lark = new FakeLark();
  const bridge = new Bridge({
    config: {
      allowedUserIds: ["ou_allowed"],
      allowedChatIds: ["oc_chat"],
      requireP2P: true,
      workspaces: { project: "/tmp/project" },
      defaultWorkspace: "project",
      recentThreadLimit: 5,
      pollIntervalMs,
      maxQueuedMessagesPerThread: 10,
      detailUpdateDebounceMs: 10,
      detailCardTokenTtlMs: 60_000,
      stateFile: path.join(tempDir, "state.json"),
      ...configOverrides
    },
    codex,
    codexDaemon,
    lark,
    logger: new FakeLogger(),
    lock: new FakeLock()
  });
  await bridge.start();
  return { bridge, codex, lark, tempDir };
}

test("a failed reply remains durable without rerunning the accepted task", async () => {
  const { bridge, codex, lark, tempDir } = await makeBridge(null);
  const send = lark.replyCard.bind(lark);
  lark.replyCard = async () => { throw new Error("network timeout"); };
  try {
    const envelope = messageEnvelope({ message_id: "om_delivery_failure", content: "请帮我检查当前项目" });
    lark.emit("event", envelope); await waitFor(() => envelope.acknowledged);
    assert.equal(codex.created.length, 1);
    assert.equal(bridge.lastReplyAt, null);
    const entry = Object.values(bridge.state.state.outbox)[0];
    assert.equal(entry.status, "pending");
    lark.emit("event", envelope);
    entry.retryAt = 0; lark.replyCard = send;
    await bridge.outbox.drain();
    assert.equal(codex.created.length, 1);
    assert.equal(lark.replies.length, 1);
    assert.equal(entry.status, "delivered");
  } finally { await bridge.stop(); await rm(tempDir, { recursive: true, force: true }); }
});

test("ambiguous task creation is reconciled by clientId without creating again", async () => {
  const { bridge, codex, lark, tempDir } = await makeBridge(null, { pollIntervalMs: 20 });
  let starts = 0; let found = false;
  codex.createTask = async (input) => {
    starts += 1; await input.onThreadStarted("thread-recovered");
    throw Object.assign(new Error("connection dropped"), { requestOutcome: "unknown", requestMethod: "turn/start" });
  };
  codex.findTurnByClientId = async () => found ? { id: "turn-recovered", status: "inProgress", items: [] } : null;
  try {
    const envelope = messageEnvelope({ message_id: "om_uncertain", content: "请帮我检查当前项目" });
    lark.emit("event", envelope); await waitFor(() => envelope.acknowledged);
    assert.equal(lark.replies[0].content.header.title.content, "请求待核对");
    found = true;
    await waitFor(() => Object.values(bridge.state.state.submissions)[0].applied);
    assert.equal(starts, 1);
    assert.equal(bridge.state.getWatch("thread-recovered").turnId, "turn-recovered");
    assert.equal(bridge.state.getChat("oc_chat").selectedThreadId, "thread-recovered");
    assert.ok(lark.replies.some((item) => item.content.header.title.content === "已核对 Codex 请求"));
  } finally { await bridge.stop(); await rm(tempDir, { recursive: true, force: true }); }
});

test("completion ignores late old events and never substitutes another turn's answer", async () => {
  const thread = { id: "thread-exact", name: "exact", status: { type: "idle" }, turns: [
    { id: "current", status: "completed", items: [{ type: "agentMessage", phase: "final_answer", text: "correct final" }] },
    { id: "other", status: "completed", items: [{ type: "agentMessage", phase: "final_answer", text: "unrelated answer" }] }
  ] };
  const { bridge, codex, lark, tempDir } = await makeBridge(thread);
  try {
    bridge.state.watchThread(thread.id, { turnId: "current", messageId: "om_source", chatId: "oc_chat" });
    codex.emit("turn/completed", { threadId: thread.id, turn: thread.turns[1] });
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.equal(lark.replies.length, 0);
    codex.emit("turn/completed", { threadId: thread.id, turn: thread.turns[0] });
    codex.emit("turn/completed", { threadId: thread.id, turn: thread.turns[0] });
    await waitFor(() => bridge.state.getWatch(thread.id).notified);
    assert.equal(lark.replies.length, 1);
    assert.match(JSON.stringify(lark.replies[0].content), /correct final/);
    assert.doesNotMatch(JSON.stringify(lark.replies[0].content), /unrelated answer/);
  } finally { await bridge.stop(); await rm(tempDir, { recursive: true, force: true }); }
});

test("an ambiguous card update does not emit a duplicate fallback message", async () => {
  const { bridge, lark, tempDir } = await makeBridge(null);
  lark.updateCard = async () => { throw new Error("timeout after accepted update"); };
  try {
    const envelope = cardActionEnvelope({ action: "home" });
    lark.emit("event", envelope); await waitFor(() => envelope.acknowledged);
    assert.equal(lark.replies.length, 0);
    assert.equal(Object.values(bridge.state.state.outbox)[0].status, "unknown");
    lark.updateCard = async () => { throw Object.assign(new Error("expired token"), { deliveryOutcome: "rejected" }); };
    const retry = cardActionEnvelope({ action: "home" });
    lark.emit("event", retry); await waitFor(() => retry.acknowledged);
    assert.equal(lark.replies.length, 1);
  } finally { await bridge.stop(); await rm(tempDir, { recursive: true, force: true }); }
});

test("keeps automatic Desktop navigation disabled while shared sync is enabled", async () => {
  const { bridge, tempDir } = await makeBridge(null, {
    configOverrides: {
      desktopSyncEnabled: true,
      desktopAutoOpenEnabled: false
    }
  });
  try {
    assert.equal(bridge.desktopSync.enabled, false);
  } finally {
    await bridge.stop();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("enabled groups route owner mentions and keep replies in the main chat stream", async () => {
  const { bridge, codex, lark, tempDir } = await makeBridge(null, { configOverrides: {
    allowedGroupChatIds: ["oc_group"], botOpenId: "ou_bot"
  } });
  try {
    const group = messageEnvelope({ chat_type: "group", chat_id: "oc_group", content: "@EDITH @Bridge 助手 任务",
      mentions: [{ id: "ou_bot", name: "EDITH" }, { id: "ou_other", name: "Bridge 助手" }] });
    lark.emit("event", group);
    await waitFor(() => group.acknowledged);
    assert.equal(lark.replies.length, 1);
    assert.equal(codex.created.length, 0);
    assert.equal(lark.replies[0].content.header.title.content, "Codex 任务");
    assert.deepEqual(lark.replies[0].options, { replyInThread: false });
    assert.equal(bridge.state.getChat("oc_group").chatType, "group");
    const privateMessage = messageEnvelope(); lark.emit("event", privateMessage);
    await waitFor(() => privateMessage.acknowledged);
    assert.deepEqual(lark.replies.at(-1).options, { replyInThread: false });
    for (const fields of [{ sender_id: "ou_stranger" }, { sender_type: "bot" }, { chat_id: "oc_other" },
      { mentions: [] }, { mentions: [{ id: "ou_other", name: "EDITH" }] }, { mentions: [{ id: "all" }] }]) {
      const ignored = messageEnvelope({ ...group.event, message_id: `om_ignored_${Math.random()}`, ...fields });
      lark.emit("event", ignored); await waitFor(() => ignored.acknowledged);
    }
    assert.equal(lark.replies.length, 2);
  } finally { await bridge.stop(); await rm(tempDir, { recursive: true, force: true }); }
});

test("group card callbacks retain owner and chat authorization and group reply routing", async () => {
  const { bridge, lark, tempDir } = await makeBridge(null, { configOverrides: {
    allowedGroupChatIds: ["oc_group"], botOpenId: "ou_bot"
  } });
  try {
    for (const fields of [{ operator_id: "ou_stranger", chat_id: "oc_group" },
      { operator_id: "ou_allowed", chat_id: "oc_other" }]) {
      const denied = cardActionEnvelope({ action: "home" }); Object.assign(denied.event, fields);
      lark.emit("event", denied); await waitFor(() => denied.acknowledged);
    }
    assert.equal(lark.updates.length, 0); assert.equal(lark.replies.length, 0);
    const allowed = cardActionEnvelope({ action: "home", token: null }); allowed.event.chat_id = "oc_group";
    lark.emit("event", allowed); await waitFor(() => allowed.acknowledged);
    assert.equal(lark.replies.length, 1);
    assert.equal(bridge.state.getChat("oc_group").chatType, "group");
    assert.deepEqual(lark.replies[0].options, { replyInThread: false });
  } finally { await bridge.stop(); await rm(tempDir, { recursive: true, force: true }); }
});

test("starts the official daemon before reconnecting the Codex client", async () => {
  const startOrder = [];
  const codexDaemon = {
    async ensureRunning() {
      startOrder.push("daemon");
      return { attempted: true, status: "already_running" };
    },
    snapshot() { return { enabled: true, recovering: false }; }
  };
  const { bridge, tempDir } = await makeBridge(null, { codexReady: false, codexDaemon, startOrder });
  try {
    assert.deepEqual(startOrder, ["daemon", "codex"]);
  } finally {
    await bridge.stop();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("lists tasks and sends a completion card", async () => {
  const thread = {
    id: "019f0000-0000-7000-8000-000000000001",
    name: "测试任务",
    cwd: "/tmp/project",
    preview: "测试任务",
    status: { type: "active", activeFlags: [] },
    turns: [{ id: "turn-1", status: "inProgress", items: [] }]
  };
  const { bridge, codex, lark, tempDir } = await makeBridge(thread);
  try {
    const list = messageEnvelope({ message_id: "om_list", content: "任务" });
    lark.emit("event", list);
    await waitFor(() => lark.replies.length === 1);
    assert.equal(lark.replies[0].content.header.title.content, "Codex 任务");
    assert.equal(list.acknowledged, true);

    const progress = messageEnvelope({ message_id: "om_progress", content: "进度1" });
    lark.emit("event", progress);
    await waitFor(() => lark.replies.length === 2);
    assert.equal(lark.replies[1].content.header.title.content, "测试任务");

    thread.status = { type: "idle" };
    thread.turns[0].status = "completed";
    thread.turns[0].items = [{ id: "answer", type: "agentMessage", text: "完成结果" }];
    codex.emit("turn/completed", { threadId: thread.id, turn: thread.turns[0] });
    await waitFor(() => lark.replies.length === 3);
    await waitFor(() => codex.unsubscribed.length === 1);
    assert.equal(lark.replies[2].messageId, "om_progress");
    assert.equal(lark.replies[2].content.header.title.content, "Codex 任务已完成");
    assert.deepEqual(codex.unsubscribed, [thread.id]);
  } finally {
    await bridge.stop();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("opens structured task detail and updates the same card from Codex events", async () => {
  const thread = {
    id: "019f0000-0000-7000-8000-000000000120",
    name: "Firebase 活跃用户",
    cwd: "/tmp/project",
    status: { type: "active", activeFlags: [] },
    updatedAt: Date.now(),
    turns: [{
      id: "turn-detail",
      status: "inProgress",
      startedAt: Math.floor(Date.now() / 1000) - 30,
      items: [{ id: "agent", type: "agentMessage", phase: "commentary", text: "正在准备 Firebase MCP" }]
    }]
  };
  const { bridge, codex, lark, tempDir } = await makeBridge(thread);
  try {
    const summary = messageEnvelope({ message_id: "om_detail_summary", content: "进度1" });
    lark.emit("event", summary);
    await waitFor(() => lark.replies.length === 1);

    const detail = cardActionEnvelope({
      action: "progress_detail",
      value: { threadId: thread.id },
      messageId: "om_bot_1",
      token: "detail-token"
    });
    lark.emit("event", detail);
    await waitFor(() => lark.updates.length === 1);
    assert.match(JSON.stringify(lark.updates[0].content), /详细进展/);
    assert.equal(detail.acknowledged, true);

    codex.emit("notification", {
      method: "turn/plan/updated",
      params: {
        threadId: thread.id,
        turnId: "turn-detail",
        plan: [
          { step: "检查配置", status: "completed" },
          { step: "查询用户", status: "inProgress" }
        ]
      }
    });
    codex.emit("notification", {
      method: "item/started",
      params: {
        threadId: thread.id,
        turnId: "turn-detail",
        item: { id: "mcp", type: "mcpToolCall", server: "firebase", tool: "list_users", status: "inProgress", arguments: {} }
      }
    });
    await waitFor(() => lark.updates.length === 2);
    const liveCard = JSON.stringify(lark.updates[1].content);
    assert.match(liveCard, /执行计划 1\/2/);
    assert.match(liveCard, /firebase\/list_users/);
    assert.equal(lark.updates[1].token, "detail-token");
    assert.equal(lark.replies.length, 1);
  } finally {
    await bridge.stop();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("falls back to thread snapshot pagination when the daemon has not implemented item paging", async () => {
  const items = Array.from({ length: 30 }, (_, index) => ({
    id: `agent-${index}`,
    type: "agentMessage",
    phase: "commentary",
    text: `进展 ${index}`
  }));
  const thread = {
    id: "019f0000-0000-7000-8000-000000000121",
    name: "兼容旧 daemon",
    cwd: "/tmp/project",
    status: { type: "active", activeFlags: [] },
    turns: [{ id: "turn-fallback", status: "inProgress", items }]
  };
  const { bridge, codex, lark, tempDir } = await makeBridge(thread);
  let pageAttempts = 0;
  codex.listThreadItems = async () => {
    pageAttempts += 1;
    throw new Error("thread/items/list is not supported yet");
  };
  try {
    lark.emit("event", messageEnvelope({ message_id: "om_detail_fallback_1", content: "详情" }));
    await waitFor(() => lark.replies.length === 1);
    assert.match(JSON.stringify(lark.replies[0].content), /更早记录/);
    assert.match(JSON.stringify(lark.replies[0].content), /local:24/);

    lark.emit("event", cardActionEnvelope({
      action: "progress_detail",
      value: { threadId: thread.id, turnId: "turn-fallback", cursor: "local:24" },
      messageId: "om_bot_1",
      token: "fallback-token"
    }));
    await waitFor(() => lark.updates.length === 1);
    assert.match(JSON.stringify(lark.updates[0].content), /较早记录/);
    assert.match(JSON.stringify(lark.updates[0].content), /返回最新/);

    lark.emit("event", messageEnvelope({ message_id: "om_detail_fallback_2", content: "详情" }));
    await waitFor(() => lark.replies.length === 2);
    assert.equal(pageAttempts, 1);
    assert.match(JSON.stringify(lark.replies[1].content), /详细进展/);
  } finally {
    await bridge.stop();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("creates a task only from a configured workspace", async () => {
  const { bridge, codex, lark, tempDir } = await makeBridge(null);
  try {
    const create = messageEnvelope({ message_id: "om_create", content: "新建 project 检查正式版创建任务" });
    lark.emit("event", create);
    await waitFor(() => lark.replies.length === 1);
    assert.equal(codex.created.length, 1);
    assert.equal(codex.created[0].cwd, "/tmp/project");
    assert.equal(lark.replies[0].content.header.title.content, "检查正式版创建任务");

    const invalid = messageEnvelope({ message_id: "om_invalid", content: "新建 unknown 不允许的目录" });
    lark.emit("event", invalid);
    await waitFor(() => lark.replies.length === 2);
    assert.equal(codex.created.length, 1);
    assert.equal(lark.replies[1].content.header.title.content, "处理失败");
  } finally {
    await bridge.stop();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("continues a newly created active task with the stored turn id", async () => {
  const { bridge, codex, lark, tempDir } = await makeBridge(null);
  try {
    const create = messageEnvelope({ message_id: "om_create_continue", content: "新建 project 创建后继续测试" });
    lark.emit("event", create);
    await waitFor(() => lark.replies.length === 1);

    const send = messageEnvelope({ message_id: "om_send_continue", content: "继续 补充一条要求" });
    lark.emit("event", send);
    await waitFor(() => lark.replies.length === 2);

    assert.equal(codex.readCount > 0, true);
    assert.equal(codex.sent.length, 1);
    assert.equal(codex.sent[0].options.expectedTurnId, "019f-created-turn");
    assert.equal(lark.replies[1].content.header.title.content, "已发送给 Codex");
  } finally {
    await bridge.stop();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("keeps a continuation in the bridge queue while Codex Desktop owns the writer", async () => {
  const thread = {
    id: "019f0000-0000-7000-8000-000000000004",
    name: "已停止任务",
    cwd: "/tmp/project",
    status: { type: "notLoaded" },
    turns: [{ id: "turn-stopped", status: "interrupted", items: [] }]
  };
  const { bridge, codex, lark, tempDir } = await makeBridge(thread);
  codex.sendMessage = async (threadId, text, selectedThread, options) => {
    codex.sent.push({ threadId, text, thread: selectedThread, options });
    throw new Error(`thread ${threadId} already has an active writer`);
  };
  try {
    bridge.state.selectThread("oc_chat", thread.id);
    lark.emit("event", messageEnvelope({ message_id: "om_writer_queue", content: "继续 修复剩余问题" }));
    await waitFor(() => lark.replies.length === 1);
    assert.equal(codex.sent.length, 1);
    assert.equal(lark.replies[0].content.header.title.content, "消息已加入队列");
    assert.equal(bridge.state.queuedFor(thread.id).length, 1);
    assert.equal(bridge.state.isWatching(thread.id), true);

    codex.emit("turn/completed", { threadId: thread.id, turn: thread.turns[0] });
    await waitFor(() => codex.sent.length === 3);
    assert.equal(bridge.state.queuedFor(thread.id).length, 1);

    codex.sendMessage = async (threadId, text, selectedThread, options) => {
      codex.sent.push({ threadId, text, thread: selectedThread, options });
      return { id: "turn-retried", status: "inProgress", items: [] };
    };
    codex.emit("turn/completed", { threadId: thread.id, turn: thread.turns[0] });
    await waitFor(() => bridge.state.queuedFor(thread.id).length === 0);
    assert.equal(codex.sent.length, 4);
    assert.equal(lark.replies.at(-1).content.header.title.content, "排队消息已发送");
  } finally {
    await bridge.stop();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("queues a message while the task is active in Codex Desktop", async () => {
  const thread = {
    id: "019f0000-0000-7000-8000-000000000002",
    name: "Desktop 任务",
    cwd: "/tmp/project",
    status: { type: "notLoaded" },
    path: null,
    rollout: { status: "inProgress", turnId: "desktop-turn" },
    turns: []
  };
  const { bridge, codex, lark, tempDir } = await makeBridge(thread);
  try {
    const list = messageEnvelope({ message_id: "om_list_queue", content: "任务" });
    lark.emit("event", list);
    await waitFor(() => lark.replies.length === 1);
    const send = messageEnvelope({ message_id: "om_queue", content: "继续1 完成后再检查一次" });
    lark.emit("event", send);
    await waitFor(() => lark.replies.length === 2);
    assert.equal(codex.sent.length, 0);
    assert.equal(lark.replies[1].content.header.title.content, "消息已加入队列");
  } finally {
    await bridge.stop();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("keeps the writer while dispatching the next queued turn", async () => {
  const thread = {
    id: "019f0000-0000-7000-8000-000000000003",
    name: "连续任务",
    cwd: "/tmp/project",
    status: { type: "active" },
    turns: [{ id: "turn-current", status: "inProgress", items: [] }]
  };
  const { bridge, codex, lark, tempDir } = await makeBridge(thread);
  try {
    bridge.state.selectThread("oc_chat", thread.id);
    lark.emit("event", messageEnvelope({ message_id: "om_queue_next", content: "继续 下一轮要求" }));
    await waitFor(() => lark.replies.length === 1);
    assert.equal(bridge.state.queuedFor(thread.id).length, 0);

    bridge.state.enqueue(thread.id, {
      text: "排队后的下一轮",
      chatId: "oc_chat",
      sourceMessageId: "om_queue_source",
      senderId: "ou_allowed"
    }, 10);
    bridge.state.watchThread(thread.id, {
      chatId: "oc_chat",
      messageId: "om_queue_source",
      senderId: "ou_allowed",
      turnId: "turn-current"
    });
    thread.status = { type: "idle" };
    thread.turns[0].status = "completed";
    codex.emit("turn/completed", { threadId: thread.id, turn: thread.turns[0] });
    await waitFor(() => codex.sent.some((item) => item.text === "排队后的下一轮"));
    assert.equal(codex.unsubscribed.length, 0);
  } finally {
    await bridge.stop();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("advances a queued watch and releases a completed Desktop writer before dispatch", async () => {
  const thread = {
    id: "019f0000-0000-7000-8000-000000000012",
    name: "Desktop 后续任务",
    cwd: "/tmp/project",
    status: { type: "idle" },
    turns: [{ id: "turn-new", status: "completed", items: [] }]
  };
  const { bridge, codex, lark, tempDir } = await makeBridge(thread, { pollIntervalMs: 20 });
  const rolloutPath = path.join(tempDir, "rollout.jsonl");
  let writerOwned = true;
  codex.readThread = async () => {
    codex.readCount += 1;
    if (writerOwned) throw new Error(`thread ${thread.id} already has an active writer`);
    return thread;
  };
  codex.unsubscribeThread = async (threadId) => {
    codex.unsubscribed.push(threadId);
    writerOwned = false;
    return { status: "unsubscribed" };
  };
  try {
    await writeFile(rolloutPath, `${JSON.stringify({
      timestamp: "2026-08-31T11:07:09Z",
      type: "turn_context",
      payload: { turn_id: "turn-new" }
    })}\n`);
    bridge.state.enqueue(thread.id, {
      text: "上一回合结束后继续",
      chatId: "oc_chat",
      sourceMessageId: "om_queued_desktop",
      senderId: "ou_allowed"
    });
    bridge.state.watchThread(thread.id, {
      chatId: "oc_chat",
      messageId: "om_queued_desktop",
      senderId: "ou_allowed",
      turnId: "turn-old",
      rolloutPath
    });
    await bridge.state.save();

    await waitFor(() => bridge.state.getWatch(thread.id)?.turnId === "turn-new");
    assert.equal(codex.sent.length, 0);
    assert.equal(codex.unsubscribed.length, 0);

    await writeFile(rolloutPath, [
      {
        timestamp: "2026-08-31T11:07:09Z",
        type: "turn_context",
        payload: { turn_id: "turn-new" }
      },
      {
        timestamp: "2026-08-31T11:08:09Z",
        type: "event_msg",
        payload: { type: "task_complete", turn_id: "turn-new", last_agent_message: "已完成" }
      }
    ].map(JSON.stringify).join("\n") + "\n");

    await waitFor(() => bridge.state.queuedFor(thread.id).length === 0);
    assert.deepEqual(codex.unsubscribed, [thread.id]);
    assert.equal(codex.sent.length, 1);
    assert.equal(codex.sent[0].text, "上一回合结束后继续");
    assert.equal(lark.replies.at(-1).content.header.title.content, "排队消息已发送");
  } finally {
    await bridge.stop();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("retries a queued send after a completed Desktop writer conflict", async () => {
  const thread = {
    id: "019f0000-0000-7000-8000-000000000013",
    name: "Desktop 写入冲突",
    cwd: "/tmp/project",
    status: { type: "idle" },
    turns: [{ id: "turn-completed", status: "completed", items: [] }]
  };
  const { bridge, codex, lark, tempDir } = await makeBridge(thread);
  let writerOwned = true;
  codex.sendMessage = async (threadId, text, selectedThread, options) => {
    codex.sent.push({ threadId, text, thread: selectedThread, options });
    if (writerOwned) throw new Error(`thread ${threadId} already has an active writer`);
    return { id: "turn-after-release", status: "inProgress", items: [] };
  };
  codex.unsubscribeThread = async (threadId) => {
    codex.unsubscribed.push(threadId);
    writerOwned = false;
    return { status: "unsubscribed" };
  };
  try {
    bridge.state.enqueue(thread.id, {
      text: "释放后继续",
      chatId: "oc_chat",
      sourceMessageId: "om_writer_retry",
      senderId: "ou_allowed"
    });
    bridge.state.watchThread(thread.id, {
      chatId: "oc_chat",
      messageId: "om_writer_retry",
      senderId: "ou_allowed",
      turnId: "turn-completed"
    });
    await bridge.state.save();

    codex.emit("turn/completed", { threadId: thread.id, turn: thread.turns[0] });
    await waitFor(() => bridge.state.queuedFor(thread.id).length === 0);
    assert.deepEqual(codex.unsubscribed, [thread.id]);
    assert.equal(codex.sent.length, 2);
    assert.equal(codex.sent[0].options.clientUserMessageId, codex.sent[1].options.clientUserMessageId);
    assert.equal(bridge.state.getWatch(thread.id).turnId, "turn-after-release");
    assert.equal(lark.replies.at(-1).content.header.title.content, "排队消息已发送");
  } finally {
    await bridge.stop();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("turns a normal Feishu sentence into a visible Codex task", async () => {
  const { bridge, codex, lark, tempDir } = await makeBridge(null);
  try {
    const request = messageEnvelope({ message_id: "om_natural_create", content: "最近一个 PR 是谁的" });
    lark.emit("event", request);
    await waitFor(() => lark.replies.length === 1);
    assert.equal(codex.created.length, 1);
    assert.equal(codex.created[0].prompt, "最近一个 PR 是谁的");
    assert.equal(lark.replies[0].content.header.title.content, "最近一个 PR 是谁的");
  } finally {
    await bridge.stop();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("routes a reply to the task bound to the replied bot card", async () => {
  const { bridge, codex, lark, tempDir } = await makeBridge(null);
  try {
    lark.emit("event", messageEnvelope({ message_id: "om_bound_create", content: "检查第一个任务" }));
    await waitFor(() => lark.replies.length === 1);
    bridge.state.selectThread("oc_chat", "019f0000-0000-7000-8000-00000000ffff");
    const reply = messageEnvelope({
      message_id: "om_bound_reply",
      reply_to: "om_bot_1",
      content: "补充检查作者邮箱"
    });
    lark.emit("event", reply);
    await waitFor(() => lark.replies.length === 2);
    assert.equal(codex.sent.length, 1);
    assert.equal(codex.sent[0].threadId, "019f0000-0000-7000-8000-00000000c001");
  } finally {
    await bridge.stop();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("asks for one-tap clarification instead of guessing an ambiguous short message", async () => {
  const thread = {
    id: "019f0000-0000-7000-8000-000000000010",
    name: "当前任务",
    cwd: "/tmp/project",
    status: { type: "idle" },
    turns: []
  };
  const { bridge, codex, lark, tempDir } = await makeBridge(thread);
  try {
    bridge.state.selectThread("oc_chat", thread.id);
    lark.emit("event", messageEnvelope({ message_id: "om_clarify", content: "这个呢" }));
    await waitFor(() => lark.replies.length === 1);
    assert.equal(codex.created.length, 0);
    assert.equal(codex.sent.length, 0);
    assert.equal(lark.replies[0].content.header.title.content, "确认这条消息要发到哪里");
    assert.equal(Object.keys(bridge.state.state.pendingIntents).length, 1);
  } finally {
    await bridge.stop();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("queues new work while Codex is offline and dispatches it after reconnect", async () => {
  const { bridge, codex, lark, tempDir } = await makeBridge(null);
  try {
    codex.ready = false;
    lark.emit("event", messageEnvelope({ message_id: "om_offline", content: "检查离线恢复" }));
    await waitFor(() => lark.replies.length === 1);
    assert.equal(lark.replies[0].content.header.title.content, "任务已进入离线队列");
    assert.equal(bridge.state.allOperations().length, 1);

    codex.ready = true;
    codex.emit("ready");
    await waitFor(() => codex.created.length === 1);
    await waitFor(() => bridge.state.allOperations().length === 0);
  } finally {
    await bridge.stop();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("queues a continuation when an active task has not exposed its turn id yet", async () => {
  const thread = {
    id: "019f0000-0000-7000-8000-000000000011",
    name: "同步中的任务",
    cwd: "/tmp/project",
    status: { type: "active" },
    turns: []
  };
  const { bridge, codex, lark, tempDir } = await makeBridge(thread);
  try {
    bridge.state.selectThread("oc_chat", thread.id);
    lark.emit("event", messageEnvelope({ message_id: "om_missing_turn", content: "继续 补充要求" }));
    await waitFor(() => lark.replies.length === 1);
    assert.equal(codex.sent.length, 0);
    assert.equal(bridge.state.queuedFor(thread.id).length, 1);
    assert.equal(lark.replies[0].content.header.title.content, "消息已加入队列");
  } finally {
    await bridge.stop();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("creates a persistent schedule without starting Codex immediately", async () => {
  const { bridge, codex, lark, tempDir } = await makeBridge(null);
  try {
    lark.emit("event", messageEnvelope({
      message_id: "om_schedule",
      content: "定时 30分钟后 project 检查 CI"
    }));
    await waitFor(() => lark.replies.length === 1);
    assert.equal(codex.created.length, 0);
    assert.equal(bridge.state.schedulesForChat("oc_chat").length, 1);
    assert.equal(lark.replies[0].content.header.title.content, "定时任务详情");
  } finally {
    await bridge.stop();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("dispatches a due one-shot schedule exactly once", async () => {
  const { bridge, codex, lark, tempDir } = await makeBridge(null, { pollIntervalMs: 20 });
  try {
    lark.emit("event", messageEnvelope({
      message_id: "om_schedule_due",
      content: "定时 1分钟后 project 运行计划任务"
    }));
    await waitFor(() => lark.replies.length === 1);
    const schedule = bridge.state.schedulesForChat("oc_chat")[0];
    bridge.state.updateSchedule(schedule.id, { nextRunAt: Date.now() - 1 });
    await bridge.state.save();
    await waitFor(() => codex.created.length === 1);
    await waitFor(() => bridge.state.getSchedule(schedule.id).status === "completed");
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(codex.created.length, 1);
  } finally {
    await bridge.stop();
    await rm(tempDir, { recursive: true, force: true });
  }
});
