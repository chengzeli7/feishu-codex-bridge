import test from "node:test";
import assert from "node:assert/strict";
import { normalizeMessage, parseCommand, resolveThreadId } from "../src/commands.mjs";

test("normalizes a Codex mention prefix", () => {
  assert.equal(normalizeMessage("@Codex：进度 1"), "进度 1");
});

test("parses list and progress commands", () => {
  assert.deepEqual(parseCommand("最近任务"), { type: "list", filter: null });
  assert.deepEqual(parseCommand("进度 2"), { type: "progress", selector: "2" });
  assert.deepEqual(parseCommand("进度1"), { type: "progress", selector: "1" });
  assert.deepEqual(parseCommand("详情1"), { type: "progress_detail", selector: "1" });
  assert.deepEqual(parseCommand("查看详细进展"), { type: "progress_detail", selector: null });
});

test("parses send with and without selector", () => {
  assert.deepEqual(parseCommand("继续 2 修复测试"), { type: "send", selector: "2", message: "修复测试" });
  assert.deepEqual(parseCommand("继续2 修复测试"), { type: "send", selector: "2", message: "修复测试" });
  assert.deepEqual(parseCommand("继续 修复测试"), { type: "send", selector: null, message: "修复测试" });
});

test("resolves numbered, selected and newest threads", () => {
  const state = { recentThreadIds: ["a", "b"], selectedThreadId: "selected" };
  assert.equal(resolveThreadId("2", state), "b");
  assert.equal(resolveThreadId(null, state), "selected");
  assert.equal(resolveThreadId(null, {}, [{ id: "newest" }]), "newest");
});

test("parses formal task management commands", () => {
  assert.deepEqual(parseCommand("新建"), { type: "create_form" });
  assert.deepEqual(parseCommand("新建 android-main 修复登录问题"), { type: "create", workspace: "android-main", message: "修复登录问题" });
  assert.deepEqual(parseCommand("搜索 登录"), { type: "search", query: "登录" });
  assert.deepEqual(parseCommand("重命名1 新名称"), { type: "removed_rename" });
  assert.deepEqual(parseCommand("停止1"), { type: "stop", selector: "1" });
  assert.deepEqual(parseCommand("静默 2小时"), { type: "mute", durationMs: 7_200_000 });
  assert.deepEqual(parseCommand("定时任务"), { type: "schedule_list" });
  assert.deepEqual(parseCommand("定时 每天 09:00 检查 CI"), { type: "schedule_create", expression: "每天 09:00 检查 CI" });
  assert.deepEqual(parseCommand("暂停定时1"), { type: "schedule_pause", selector: "1" });
});
