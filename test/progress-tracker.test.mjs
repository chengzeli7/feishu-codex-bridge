import test from "node:test";
import assert from "node:assert/strict";
import { ProgressTracker, redactSensitive } from "../src/progress-tracker.mjs";

const threadId = "019f0000-0000-7000-8000-000000000100";
const turnId = "019f0000-0000-7000-8000-000000000101";

function thread(items = []) {
  return {
    id: threadId,
    name: "查询 Firebase 用户活跃数据",
    cwd: "/tmp/project",
    status: { type: "active" },
    updatedAt: 1_700_000_010,
    turns: [{
      id: turnId,
      status: "inProgress",
      startedAt: 1_700_000_000,
      items
    }]
  };
}

test("builds structured live progress without exposing reasoning", () => {
  const tracker = new ProgressTracker({ now: () => 1_700_000_015_000 });
  tracker.ingest("turn/plan/updated", {
    threadId,
    turnId,
    explanation: "先检查配置，再查询数据",
    plan: [
      { step: "检查 Firebase 配置", status: "completed" },
      { step: "查询活跃用户", status: "inProgress" },
      { step: "整理结果", status: "pending" }
    ]
  });
  tracker.ingest("item/started", {
    threadId,
    turnId,
    item: {
      id: "mcp-1",
      type: "mcpToolCall",
      server: "firebase",
      tool: "list_active_users",
      arguments: { token: "secret-value" },
      status: "inProgress"
    }
  });
  tracker.ingest("item/mcpToolCall/progress", {
    threadId,
    turnId,
    itemId: "mcp-1",
    message: "正在初始化 Firebase MCP"
  });

  const snapshot = tracker.snapshot(thread([{
    id: "reasoning-1",
    type: "reasoning",
    summary: ["private reasoning"]
  }]), {
    turnId,
    page: { items: [], nextCursor: null },
    cursor: null
  });

  assert.equal(snapshot.planCompleted, 1);
  assert.equal(snapshot.planTotal, 3);
  assert.match(snapshot.currentStage, /查询活跃用户/);
  assert.equal(snapshot.activities.some((item) => item.type === "reasoning"), false);
  assert.equal(snapshot.activities[0].label, "firebase/list_active_users");
  assert.equal(snapshot.activities[0].detail, "正在初始化 Firebase MCP");
  assert.equal(JSON.stringify(snapshot).includes("secret-value"), false);
});

test("summarizes commands, files and sanitized failures", () => {
  const tracker = new ProgressTracker({ now: () => 1_700_000_015_000 });
  const items = [
    {
      id: "command-1",
      type: "commandExecution",
      command: "curl -H 'Authorization: Bearer abcdefghijklmnop' 'https://example.test?token=top-secret'",
      commandActions: [],
      cwd: "/tmp/project",
      status: "failed",
      exitCode: 1,
      aggregatedOutput: "password=super-secret request failed"
    },
    {
      id: "file-1",
      type: "fileChange",
      status: "completed",
      changes: [{ path: "/tmp/project/src/app.mjs", kind: { type: "update" }, diff: "" }]
    }
  ];
  const snapshot = tracker.snapshot(thread(items), {
    turnId,
    page: { items: [...items].reverse(), nextCursor: "older" },
    cursor: null
  });

  assert.deepEqual(snapshot.stats, { tools: 0, commands: 1, files: 1, errors: 1 });
  assert.equal(snapshot.files[0].path, "src/app.mjs");
  const command = snapshot.activities.find((item) => item.type === "commandExecution");
  assert.match(command.detail, /Authorization: \[REDACTED\]/);
  assert.equal(command.detail.includes("abcdefghijklmnop"), false);
  assert.match(command.detail, /token=\[REDACTED\]/);
  assert.match(command.error, /password=\[REDACTED\]/);
  assert.equal(snapshot.page.nextCursor, "older");
});

test("redacts common credential forms", () => {
  const value = redactSensitive("api_key=abcdef token:xyz Bearer abcdef sk-1234567890abcdefgh");
  assert.equal(value.includes("abcdef"), false);
  assert.equal(value.includes("xyz"), false);
  assert.equal(value.includes("abc def"), false);
  assert.match(value, /\[REDACTED\]/);
});
