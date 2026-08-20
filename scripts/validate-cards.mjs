import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadConfig } from "../src/config.mjs";
import {
  completionCard,
  clarificationCard,
  createTaskFormCard,
  healthCard,
  helpCard,
  noticeCard,
  progressCard,
  progressDetailCard,
  queueCard,
  scheduleDetailCard,
  scheduleListCard,
  sendMessageFormCard,
  stopConfirmCard,
  taskListCard
} from "../src/cards.mjs";

const run = promisify(execFile);
const live = process.argv.includes("--live");
const config = live
  ? await loadConfig()
  : {
      allowedUserIds: ["ou_example_user"],
      workspaces: { "example-project": process.cwd() },
      defaultWorkspace: "example-project",
      larkBin: "lark-cli"
    };
const userId = config.allowedUserIds[0];
const thread = {
  id: "019f0000-0000-7000-8000-000000000001",
  name: "正式版卡片验证任务",
  cwd: Object.values(config.workspaces)[0],
  status: { type: "active" },
  updatedAt: Date.now(),
  turns: [{ id: "019f0000-0000-7000-8000-000000000002", status: "inProgress", items: [{ id: "agent", type: "agentMessage", text: "正在验证飞书卡片结构。" }] }]
};

const samples = new Map([
  ["task-list", taskListCard([thread], { queuedCount: 1 })],
  ["create-form", createTaskFormCard(config.workspaces, config.defaultWorkspace)],
  ["progress", progressCard(thread, { watching: true, queue: [{ text: "稍后继续" }] })],
  ["progress-detail", progressDetailCard(thread, {
    turnId: thread.turns[0].id,
    status: "inProgress",
    statusLabel: "运行中",
    durationMs: 75_000,
    updatedAt: Date.now(),
    currentStage: "正在验证详细进展卡片",
    plan: [{ step: "验证卡片结构", status: "inProgress" }],
    planText: "",
    planExplanation: "",
    planCompleted: 0,
    planTotal: 1,
    activities: [{ id: "tool", type: "mcpToolCall", category: "MCP", label: "test/validate", detail: "正在执行", status: "inProgress", statusLabel: "运行中", updatedAt: Date.now(), durationMs: null, error: null }],
    files: [],
    stats: { tools: 1, commands: 0, files: 0, errors: 0 },
    page: { cursor: null, nextCursor: null, isHistorical: false },
    attention: null,
    error: null
  })],
  ["send-form", sendMessageFormCard(thread)],
  ["stop-confirm", stopConfirmCard(thread)],
  ["completion", completionCard({ ...thread, status: { type: "idle" } }, "completed", "验证完成。")],
  ["health", healthCard({ version: "1.0.0", uptime: "1小时", codexReady: true, larkReady: true, queuedCount: 0, watchCount: 1, lastMessageAt: Date.now(), lastReplyAt: Date.now(), lastError: null })],
  ["queue", queueCard([{ threadId: thread.id, text: "排队消息" }], new Map([[thread.id, thread.name]]), [{ type: "create", workspace: "android-main", text: "离线任务", status: "queued" }])],
  ["notice", noticeCard({ title: "操作成功", message: "卡片结构验证完成。", template: "green", status: "成功" })],
  ["clarification", clarificationCard({ id: "pending", message: "这个呢" }, thread, config.defaultWorkspace)],
  ["schedule-list", scheduleListCard([{ id: "schedule", prompt: "检查 CI", workspace: config.defaultWorkspace, label: "每天 09:00", status: "active", nextRunAt: Date.now() + 60_000 }])],
  ["schedule-detail", scheduleDetailCard({ id: "schedule", prompt: "检查 CI", workspace: config.defaultWorkspace, label: "每天 09:00", status: "active", nextRunAt: Date.now() + 60_000 })],
  ["help", helpCard()]
]);

function validateCardStructure(name, card) {
  if (!card || typeof card !== "object") {
    throw new Error(`${name}: card must be an object`);
  }
  if (card.schema !== "2.0") {
    throw new Error(`${name}: expected Card 2.0 schema`);
  }
  if (!card.header || typeof card.header !== "object") {
    throw new Error(`${name}: missing card header`);
  }
  if (!card.body || !Array.isArray(card.body.elements)) {
    throw new Error(`${name}: missing card body elements`);
  }

  const encoded = JSON.stringify(card);
  const decoded = JSON.parse(encoded);
  if (decoded.schema !== card.schema) {
    throw new Error(`${name}: card is not JSON serializable`);
  }
}

for (const [name, sample] of samples) {
  validateCardStructure(name, sample);
  if (live) {
    await run(config.larkBin, [
      "im", "+messages-send", "--user-id", userId,
      "--msg-type", "interactive", "--content", JSON.stringify(sample),
      "--as", "bot", "--dry-run"
    ], {
      env: {
        ...process.env,
        LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1",
        LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1"
      },
      maxBuffer: 2 * 1024 * 1024
    });
  }
  console.log(`validated ${name}`);
}

console.log(`validated ${samples.size} Card 2.0 samples (${live ? "lark-cli dry-run" : "offline"})`);
