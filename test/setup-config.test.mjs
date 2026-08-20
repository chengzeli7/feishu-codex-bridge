import test from "node:test";
import assert from "node:assert/strict";
import { buildBridgeConfig, normalizeWorkspace, pairingIdentity, PAIRING_PHRASE } from "../src/setup-config.mjs";

test("accepts an exact private-chat pairing message", () => {
  assert.deepEqual(pairingIdentity({
    chat_type: "p2p",
    sender_type: "user",
    sender_id: "ou_home_user",
    chat_id: "oc_home_chat",
    content: PAIRING_PHRASE
  }), { userId: "ou_home_user", chatId: "oc_home_chat" });
});

test("rejects non-private or unrelated pairing messages", () => {
  assert.throws(() => pairingIdentity({
    chat_type: "group",
    sender_id: "ou_home_user",
    chat_id: "oc_home_chat",
    content: PAIRING_PHRASE
  }), /私聊/);
  assert.throws(() => pairingIdentity({
    chat_type: "p2p",
    sender_id: "ou_home_user",
    chat_id: "oc_home_chat",
    content: "任务"
  }), /配对口令/);
});

test("builds a desktop-synced configuration without credentials", () => {
  const config = buildBridgeConfig({
    pairing: { userId: "ou_home_user", chatId: "oc_home_chat" },
    workspaceEntries: [{ alias: "home", directory: "/tmp/home-project", aliases: ["家庭项目"] }],
    defaultWorkspace: "home",
    larkBin: "/opt/homebrew/bin/lark-cli",
    ffmpegBin: "/opt/homebrew/bin/ffmpeg"
  });
  assert.deepEqual(config.allowedUserIds, ["ou_home_user"]);
  assert.deepEqual(config.allowedChatIds, ["oc_home_chat"]);
  assert.deepEqual(config.workspaceAliases.home, ["home", "家庭项目"]);
  assert.equal(config.desktopSyncEnabled, true);
  assert.equal(config.desktopAutoOpenEnabled, false);
  assert.equal(config.codexBin, "/Applications/ChatGPT.app/Contents/Resources/codex");
  assert.equal(Object.hasOwn(config, "appSecret"), false);
});

test("requires absolute workspace paths and unique aliases", () => {
  assert.throws(() => normalizeWorkspace({ alias: "home", directory: "relative" }), /绝对路径/);
  assert.throws(() => buildBridgeConfig({
    pairing: { userId: "ou_home_user", chatId: "oc_home_chat" },
    workspaceEntries: [
      { alias: "home", directory: "/tmp/one" },
      { alias: "home", directory: "/tmp/two" }
    ],
    defaultWorkspace: "home",
    larkBin: "lark-cli"
  }), /重复/);
});
