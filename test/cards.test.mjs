import test from "node:test";
import assert from "node:assert/strict";
import {
  clarificationCard,
  createTaskFormCard,
  healthCard,
  progressCard,
  progressDetailCard,
  scheduleDetailCard,
  scheduleListCard,
  sendMessageFormCard,
  taskListCard
} from "../src/cards.mjs";

const thread = {
  id: "019f0000-0000-7000-8000-000000000001",
  name: "测试任务",
  cwd: "/tmp/project",
  status: { type: "active" },
  turns: [{ id: "turn", status: "inProgress", items: [] }]
};

function walk(value, result = []) {
  if (Array.isArray(value)) for (const item of value) walk(item, result);
  else if (value && typeof value === "object") {
    result.push(value);
    for (const item of Object.values(value)) walk(item, result);
  }
  return result;
}

test("builds complete Card 2.0 payloads with callback actions", () => {
  const home = taskListCard([thread]);
  assert.equal(home.schema, "2.0");
  assert.equal(home.config.width_mode, "default");
  const callbacks = walk(home).filter((item) => item.type === "callback");
  assert.ok(callbacks.some((item) => item.value.action === "progress"));
  assert.ok(callbacks.some((item) => item.value.action === "create_form"));
});

test("task list exposes at most the 10 most recent tasks", () => {
  const threads = Array.from({ length: 12 }, (_, index) => ({
    ...thread,
    id: `thread-${index}`,
    name: `任务 ${index}`
  }));
  const card = taskListCard(threads);
  const taskCallbacks = walk(card)
    .filter((item) => item.type === "callback" && item.value.action === "progress");
  assert.equal(taskCallbacks.length, 10);
  assert.match(JSON.stringify(card), /最近任务 · 最多 10 条/);
  assert.doesNotMatch(JSON.stringify(card), /任务 10/);
});

test("form submit buttons use form_action_type without callback behaviors", () => {
  const cards = [
    createTaskFormCard({ app: "/tmp/app" }, "app"),
    sendMessageFormCard(thread)
  ];
  for (const card of cards) {
    const submit = walk(card).find((item) => item.form_action_type === "submit");
    assert.ok(submit);
    assert.equal(Object.hasOwn(submit, "behaviors"), false);
  }
});

test("builds clarification and schedule controls as Card 2.0 callbacks", () => {
  const pending = { id: "pending", message: "这个呢" };
  const clarificationActions = walk(clarificationCard(pending, thread, "app"))
    .filter((item) => item.type === "callback")
    .map((item) => item.value.action);
  assert.deepEqual(clarificationActions, ["clarify_continue", "clarify_create", "clarify_cancel"]);

  const schedule = {
    id: "schedule",
    prompt: "检查 CI",
    workspace: "app",
    label: "每天 09:00",
    status: "active",
    nextRunAt: Date.now() + 60_000
  };
  assert.equal(scheduleListCard([schedule]).schema, "2.0");
  const detailActions = walk(scheduleDetailCard(schedule))
    .filter((item) => item.type === "callback")
    .map((item) => item.value.action);
  assert.ok(detailActions.includes("schedule_pause"));
  assert.ok(detailActions.includes("schedule_cancel"));
});

test("progress card exposes back, continue and stop controls without rename", () => {
  const actions = walk(progressCard(thread)).filter((item) => item.type === "callback").map((item) => item.value.action);
  assert.ok(actions.includes("home"));
  assert.ok(actions.includes("progress_detail"));
  assert.ok(actions.includes("send_form"));
  assert.ok(actions.includes("stop"));
  assert.equal(actions.includes("rename_form"), false);
});

test("progress detail card renders plans, activity and pagination controls", () => {
  const detail = {
    turnId: "turn",
    status: "inProgress",
    statusLabel: "运行中",
    durationMs: 75_000,
    updatedAt: Date.now(),
    currentStage: "正在查询 Firebase 用户",
    plan: [
      { step: "检查配置", status: "completed" },
      { step: "查询数据", status: "inProgress" }
    ],
    planText: "",
    planExplanation: "按顺序执行",
    planCompleted: 1,
    planTotal: 2,
    activities: [{
      id: "mcp",
      type: "mcpToolCall",
      category: "MCP",
      label: "firebase/list_users",
      detail: "正在等待工具返回",
      status: "inProgress",
      statusLabel: "运行中",
      updatedAt: Date.now(),
      durationMs: null,
      error: null
    }],
    files: [{ path: "src/app.mjs", kind: "update", status: "completed" }],
    stats: { tools: 1, commands: 0, files: 1, errors: 0 },
    page: { cursor: null, nextCursor: "older", isHistorical: false },
    attention: null,
    error: null
  };
  const card = progressDetailCard(thread, detail);
  const serialized = JSON.stringify(card);
  assert.match(serialized, /执行计划 1\/2/);
  assert.match(serialized, /firebase\/list_users/);
  assert.match(serialized, /src\/app.mjs/);
  const actions = walk(card).filter((item) => item.type === "callback").map((item) => item.value.action);
  assert.ok(actions.includes("progress_detail"));
  assert.ok(actions.includes("progress"));
  assert.ok(actions.includes("send_form"));
  assert.ok(actions.includes("stop"));
  assert.ok(actions.includes("home"));
});

test("health card exposes official daemon recovery state", () => {
  const card = healthCard({
    version: "0.1.0",
    uptime: "1分钟",
    codexReady: false,
    larkReady: true,
    queuedCount: 0,
    watchCount: 0,
    lastMessageAt: null,
    lastReplyAt: null,
    lastError: "Codex app-server disconnected",
    codexRecovery: { enabled: true, recovering: true, lastError: null }
  });
  const serialized = JSON.stringify(card);
  assert.match(serialized, /修复中/);
  assert.match(serialized, /正在自动拉起官方服务/);
});
