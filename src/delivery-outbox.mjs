import { createHash } from "node:crypto";

export const DELIVERY_RETRY_WINDOW_MS = 55 * 60_000;

export function deliveryKey(identity) {
  const value = String(identity);
  // Preserve existing short keys, including keys used by local-only adapters.
  return value.length <= 50 ? value : `fcb-${createHash("sha256").update(value).digest("hex").slice(0, 40)}`;
}

// StateStore owns persistence. Only delivery state changes here, never execution state.
export class DeliveryOutbox {
  constructor({ state, lark, logger, now = Date.now, onDelivered = () => {} }) {
    Object.assign(this, { state, lark, logger, now, onDelivered });
    this.lanes = new Map();
  }

  async enqueue(identity, payload) {
    const id = deliveryKey(identity);
    const entries = this.state.state.outbox;
    entries[id] ??= { id, ...structuredClone(payload), status: payload.status ?? "pending", createdAt: this.now(), attempts: 0, retryAt: 0 };
    await this.state.save();
    return entries[id];
  }

  deliver(entry) {
    if (this.lanes.has(entry.id)) return this.lanes.get(entry.id);
    const pending = this.attempt(entry).finally(() => this.lanes.delete(entry.id));
    this.lanes.set(entry.id, pending);
    return pending;
  }

  async attempt(entry) {
    if (entry.status === "delivered") return entry.result;
    if (entry.status !== "pending" || entry.retryAt > this.now()) return null;
    if (entry.firstAttemptAt != null && this.now() - entry.firstAttemptAt >= DELIVERY_RETRY_WINDOW_MS) {
      entry.status = "unknown";
      await this.state.save();
      this.logger.warn("Delivery needs reconciliation; retry window elapsed", { deliveryId: entry.id });
      return null;
    }
    entry.firstAttemptAt ??= this.now();
    entry.attempts += 1;
    await this.state.save();
    try {
      const options = { replyInThread: false };
      const result = entry.messageId ?
        await (entry.type === "markdown" ? this.lark.replyMarkdown(entry.messageId, entry.content, entry.id, options) :
          this.lark.replyCard(entry.messageId, entry.content, entry.id, options)) :
        await this.lark.sendCard({ chatId: entry.chatId, card: entry.content, idempotencyKey: entry.id });
      if (!result?.message_id) throw new Error("Feishu delivery returned no message ID");
      entry.result = { message_id: result.message_id };
      entry.status = "delivered";
      entry.deliveredAt = this.now();
      if (entry.threadId) {
        this.state.bindMessage(result.message_id, { threadId: entry.threadId, chatId: entry.chatId, kind: entry.kind ?? "bot-reply" });
      }
      if (entry.watchTurnId) {
        const watch = this.state.getWatch(entry.threadId);
        if (watch?.turnId === entry.watchTurnId && watch.messageId === entry.messageId) watch.messageId = result.message_id;
      }
      await this.state.save();
      this.onDelivered(entry);
      return entry.result;
    } catch (error) {
      // Includes ambiguous network responses; the frozen payload and key survive restarts.
      if (entry.status !== "delivered") {
        entry.lastError = error.message;
        entry.retryAt = this.now() + Math.min(60_000, 2_000 * 2 ** Math.min(entry.attempts - 1, 5));
        await this.state.save();
      }
      this.logger.error("Reply delivery deferred", { deliveryId: entry.id, error: error.message });
      return null;
    }
  }

  drain() {
    if (this.draining) return this.draining;
    const entries = Object.values(this.state.state.outbox).filter((entry) => entry.status === "pending" && entry.retryAt <= this.now()).slice(0, 10);
    this.draining = (async () => {
      for (let index = 0; index < entries.length; index += 2) await Promise.all(entries.slice(index, index + 2).map((entry) => this.deliver(entry)));
    })().finally(() => { this.draining = null; });
    return this.draining;
  }
}
