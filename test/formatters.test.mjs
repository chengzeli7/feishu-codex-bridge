import test from "node:test";
import assert from "node:assert/strict";
import { formatCompletion, formatProgress, formatThreadList } from "../src/formatters.mjs";

const thread = {
  id: "019f-test",
  name: "测试任务",
  preview: "preview",
  cwd: "/tmp/project",
  status: { type: "active", activeFlags: [] },
  turns: [{
    id: "turn-1",
    status: "inProgress",
    items: [{ id: "agent-1", type: "agentMessage", text: "正在检查" }]
  }]
};

test("formats task list", () => {
  const text = formatThreadList([thread]);
  assert.match(text, /\*\*1　🟢 进行中\*\*/);
  assert.match(text, /测试任务/);
  assert.match(text, /进度1/);
});

test("formats progress using the latest agent message", () => {
  const text = formatProgress(thread);
  assert.match(text, /最近进展/);
  assert.match(text, /正在检查/);
});

test("formats completion", () => {
  const completed = structuredClone(thread);
  completed.status = { type: "idle" };
  completed.turns[0].status = "completed";
  completed.turns[0].items[0].text = "已经完成";
  assert.match(formatCompletion(completed, "completed"), /Codex 任务已完成/);
  assert.match(formatCompletion(completed, "completed"), /已经完成/);
});

test("labels a thread whose Desktop runtime is not visible", () => {
  const unloaded = structuredClone(thread);
  unloaded.status = { type: "notLoaded" };
  assert.match(formatProgress(unloaded), /无法确认另一个 Codex Desktop 进程中的实时运行状态/);
});
