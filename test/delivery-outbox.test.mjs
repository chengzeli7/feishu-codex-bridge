import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { StateStore } from "../src/state-store.mjs";
import { DeliveryOutbox, deliveryKey, DELIVERY_RETRY_WINDOW_MS } from "../src/delivery-outbox.mjs";

const logger = { info() {}, warn() {}, error() {} };
async function fixture(t, lark, now = Date.now) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "bridge-outbox-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const state = new StateStore(path.join(dir, "state.json"));
  await state.load();
  return { state, outbox: new DeliveryOutbox({ state, lark, logger, now }) };
}

test("hashes the entire identity instead of colliding on the first turn characters", () => {
  const first = "done-00000000-0000-7000-8000-000000000001-00000002-1111-7000-8000-000000000001";
  const second = first.replace("1111", "2222");
  assert.equal(first.slice(0, 50), second.slice(0, 50));
  assert.notEqual(deliveryKey(first), deliveryKey(second));
  assert.ok(deliveryKey(first).length <= 50);
  assert.equal(deliveryKey(first), deliveryKey(first));
  assert.equal(deliveryKey("result-om_short"), "result-om_short");
});

test("persists before sending and recovers the same frozen reply after restart", async (t) => {
  let clock = 1000;
  const calls = [];
  const { state, outbox } = await fixture(t, { async replyCard(...args) {
    const disk = JSON.parse(await readFile(state.filePath, "utf8"));
    assert.equal(disk.outbox.reply.attempts, 1);
    calls.push(args);
    throw new Error("response lost after send");
  } }, () => clock);
  const entry = await outbox.enqueue("reply", { type: "card", content: { text: "original" }, messageId: "om_source", chatId: "chat", threadId: "thread" });
  assert.equal(await outbox.deliver(entry), null);
  assert.equal(entry.status, "pending");
  const restored = new StateStore(state.filePath); await restored.load();
  const recovered = new DeliveryOutbox({ state: restored, logger, now: () => clock, lark: {
    async replyCard(...args) { calls.push(args); return { message_id: "om_delivered" }; }
  } });
  const same = await recovered.enqueue("reply", { type: "card", content: { text: "changed" } });
  assert.equal(same.content.text, "original");
  assert.equal(await recovered.deliver(same), null);
  clock += 2000;
  await recovered.drain();
  assert.deepEqual(calls[0], calls[1]);
  assert.deepEqual(calls[1][3], { replyInThread: false });
  assert.equal(restored.getMessageBinding("om_delivered").threadId, "thread");
  assert.equal(restored.state.outbox.reply.status, "delivered");
  await recovered.deliver(same);
  assert.equal(calls.length, 2);
});

test("serializes concurrent delivery and isolates failures across entries", async (t) => {
  let calls = 0;
  const { outbox } = await fixture(t, { async replyMarkdown(messageId) {
    calls += 1;
    if (messageId === "bad") throw new Error("offline");
    return { message_id: "om_good" };
  } });
  const bad = await outbox.enqueue("bad", { type: "markdown", messageId: "bad", content: "a" });
  const good = await outbox.enqueue("good", { type: "markdown", messageId: "good", content: "b" });
  await Promise.all([outbox.deliver(good), outbox.deliver(good), outbox.drain()]);
  assert.equal(calls, 2);
  assert.equal(good.status, "delivered");
  assert.equal(bad.status, "pending");
});

test("never retries beyond the deduplication window or sends held/unknown entries", async (t) => {
  let clock = 10;
  let calls = 0;
  const { outbox } = await fixture(t, { async replyCard() { calls += 1; throw new Error("timeout"); } }, () => clock);
  const entry = await outbox.enqueue("old", { type: "card", content: {}, messageId: "om_source" });
  await outbox.deliver(entry);
  clock += DELIVERY_RETRY_WINDOW_MS;
  await outbox.drain();
  assert.equal(entry.status, "unknown");
  await outbox.deliver(entry);
  const held = await outbox.enqueue("held", { status: "held", type: "card", content: {} });
  await outbox.deliver(held);
  assert.equal(calls, 1);
});

test("a persistence failure prevents external delivery", async () => {
  let sends = 0;
  const state = { state: { outbox: {} }, async save() { throw new Error("disk full"); } };
  const outbox = new DeliveryOutbox({ state, logger, lark: { async replyCard() { sends += 1; } } });
  await assert.rejects(outbox.enqueue("id", { content: {} }), /disk full/);
  assert.equal(sends, 0);
});
