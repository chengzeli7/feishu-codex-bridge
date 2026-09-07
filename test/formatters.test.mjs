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

test("formats a completed rollout using its final result before commentary", () => {
  const completed = structuredClone(thread);
  completed.status = { type: "notLoaded" };
  completed.rollout = {
    turnId: "turn-final",
    status: "completed",
    progress: "CI 全绿，准备合并",
    result: "PR 已合并"
  };
  const text = formatProgress(completed);
  assert.match(text, /PR 已合并/);
  assert.doesNotMatch(text, /准备合并/);
});

test("describes a thread whose Desktop runtime is not visible without exposing internal notLoaded state", () => {
  const unloaded = structuredClone(thread);
  unloaded.status = { type: "notLoaded" };
  const text = formatProgress(unloaded);
  assert.match(text, /状态未知/);
  assert.match(text, /只展示已保存的任务记录/);
  assert.doesNotMatch(text, /未载入/);
});
