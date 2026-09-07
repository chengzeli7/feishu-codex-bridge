import test from "node:test";
import assert from "node:assert/strict";
import { isMentionedGroupMessage, stripGroupMentionPrefix, validateGroupConfig } from "../src/group-policy.mjs";

const config = { allowedGroupChatIds: ["oc_group"], botOpenId: "ou_bot" };
const event = { chat_type: "group", chat_id: "oc_group", sender_type: "user",
  content: "@EDITH 任务", mentions: [{ id: "ou_bot", name: "EDITH", key: "@_user_1" }] };

test("group access requires an explicit group and a structured mention of this bot", () => {
  assert.equal(isMentionedGroupMessage(config, event), true);
  for (const fields of [{ chat_id: "oc_other" }, { sender_type: "bot" }, { chat_type: "p2p" },
    { mentions: [] }, { mentions: [{ id: "ou_other", name: "EDITH" }] }, { mentions: [{ id: "all" }] }]) {
    assert.equal(isMentionedGroupMessage(config, { ...event, ...fields }), false);
  }
  assert.equal(isMentionedGroupMessage({}, event), false);
});
test("prefix cleanup supports multi-bot mentions without removing request content", () => {
  const mentions = [...event.mentions, { id: "ou_other", name: "Bridge 助手", key: "@_user_2" }];
  for (const content of ["@EDITH @Bridge 助手 任务", "@_user_1 @_user_2 任务"]) {
    assert.equal(stripGroupMentionPrefix({ ...event, mentions, content }), "任务");
  }
  assert.equal(stripGroupMentionPrefix({ ...event, content: "@EDITH 请解释 @EDITH 的名字" }), "请解释 @EDITH 的名字");
  assert.equal(stripGroupMentionPrefix({ ...event, content: "@EDITH-other 任务" }), "@EDITH-other 任务");
  assert.equal(stripGroupMentionPrefix({ ...event, chat_type: "p2p" }), event.content);
});
test("group configuration fails closed without a verified bot ID or explicit IDs", () => {
  validateGroupConfig({}); validateGroupConfig(config);
  for (const bad of [{ allowedGroupChatIds: "all" }, { allowedGroupChatIds: ["*"] },
    { allowedGroupChatIds: ["oc_group"] }, { ...config, botOpenId: "EDITH" }]) {
    assert.throws(() => validateGroupConfig(bad));
  }
});
