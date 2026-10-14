import test from "node:test";
import assert from "node:assert/strict";
import { detectWorkspace, routeNaturalMessage } from "../src/intent-router.mjs";

const workspaces = {
  "android-main": "/tmp/example-android-main",
  memory: "/tmp/example-android-memory"
};
const aliases = {
  "android-main": ["主项目", "主仓库"],
  memory: ["记忆项目"]
};

test("routes standalone requests as new tasks in the detected workspace", () => {
  assert.equal(detectWorkspace("在记忆项目里检查同步", workspaces, aliases, "android-main"), "memory");
  assert.deepEqual(routeNaturalMessage({
    content: "最近一个 PR 是谁的",
    workspaces,
    workspaceAliases: aliases,
    defaultWorkspace: "android-main"
  }), {
    type: "create",
    workspace: "android-main",
    message: "最近一个 PR 是谁的",
    routeReason: "new_task"
  });
});

test("uses reply binding before the focused task and clarifies ambiguous short text", () => {
  assert.equal(routeNaturalMessage({
    content: "补充检查作者邮箱",
    chatState: { focusedThreadId: "focused" },
    boundThreadId: "replied",
    workspaces,
    defaultWorkspace: "android-main"
  }).selector, "replied");

  assert.deepEqual(routeNaturalMessage({
    content: "这个呢",
    chatState: { focusedThreadId: "focused" },
    workspaces,
    defaultWorkspace: "android-main"
  }), {
    type: "clarify",
    message: "这个呢",
    threadId: "focused",
    workspace: "android-main"
  });
});

test("keeps greetings out of Codex and recognizes natural schedules", () => {
  assert.equal(routeNaturalMessage({
    content: "你好",
    workspaces,
    defaultWorkspace: "android-main"
  }).type, "small_talk");
  assert.deepEqual(routeNaturalMessage({
    content: "每天 09:00 检查 CI",
    workspaces,
    defaultWorkspace: "android-main"
  }), { type: "schedule_create", expression: "每天 09:00 检查 CI" });
  assert.equal(routeNaturalMessage({
    content: "明天帮我检查这个逻辑",
    workspaces,
    defaultWorkspace: "android-main"
  }).type, "create");
});

test('ordinary follow-ups after viewing a task ask for a target instead of silently creating work', () => {
  for (const content of ['不调用工具，只回复验证通过', '帮我整理成三个要点', '检查记忆项目']) {
    const route = routeNaturalMessage({ content, chatState: { focusedThreadId: 'original' }, workspaces,
      workspaceAliases: aliases, defaultWorkspace: 'android-main' });
    assert.equal(route.type, 'clarify');
    assert.equal(route.threadId, 'original');
    assert.equal(route.message, content);
  }
  assert.equal(routeNaturalMessage({ content: '不调用工具，只回复验证通过', boundThreadId: 'quoted',
    chatState: { focusedThreadId: 'different' }, workspaces }).selector, 'quoted');
  assert.equal(routeNaturalMessage({ content: '继续整理待办', chatState: { focusedThreadId: 'original' }, workspaces }).type, 'send');
});
