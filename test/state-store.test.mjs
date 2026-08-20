import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { StateStore } from "../src/state-store.mjs";

test("migrates v1 state and serializes concurrent saves", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bridge-state-"));
  const file = path.join(directory, "state.json");
  await writeFile(file, JSON.stringify({ version: 1, chats: { chat: { selectedThreadId: "a" } }, watches: {}, processedMessageIds: [] }));
  try {
    const store = new StateStore(file);
    await store.load();
    assert.equal(store.state.version, 3);
    assert.deepEqual(store.state.queues, {});
    assert.deepEqual(store.state.messageBindings, {});
    store.selectThread("chat", "b");
    const first = store.save();
    store.selectThread("chat", "c");
    const second = store.save();
    await Promise.all([first, second]);
    const persisted = JSON.parse(await readFile(file, "utf8"));
    assert.equal(persisted.chats.chat.selectedThreadId, "c");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("deduplicates events and manages bounded queues", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bridge-state-"));
  try {
    const store = new StateStore(path.join(directory, "state.json"));
    await store.load();
    assert.equal(store.beginProcessing("event-1"), true);
    assert.equal(store.beginProcessing("event-1"), false);
    await store.finishProcessing("event-1", "event");
    assert.equal(store.beginProcessing("event-1"), false);
    const queued = store.enqueue("thread", { text: "one", chatId: "chat", sourceMessageId: "message", senderId: "user" }, 1);
    assert.equal(store.queuedFor("thread")[0].id, queued.id);
    assert.throws(() => store.enqueue("thread", { text: "two" }, 1), /最多保留 1 条/);
    assert.equal(store.shiftQueue("thread").text, "one");
    assert.equal(store.allQueued().length, 0);
    store.setMutedUntil(Date.now() + 10_000);
    assert.equal(store.isMuted(), true);
    store.bindMessage("om_bot", { threadId: "thread", chatId: "chat" });
    assert.equal(store.getMessageBinding("om_bot").threadId, "thread");
    const pending = store.createPendingIntent({ chatId: "chat", message: "继续" });
    assert.equal(store.consumePendingIntent(pending.id).message, "继续");
    const operation = store.enqueueOperation({ type: "create", text: "work" });
    assert.equal(store.pendingOperations()[0].id, operation.id);
    store.completeOperation(operation.id);
    const schedule = store.addSchedule({ chatId: "chat", prompt: "daily", status: "active" });
    assert.equal(store.schedulesForChat("chat")[0].id, schedule.id);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
