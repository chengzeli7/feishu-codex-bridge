export class SubmissionPendingError extends Error {
  constructor(id) {
    super("请求已保存，正在核对 Codex 是否已经接收；请勿重复提交。");
    this.name = "SubmissionPendingError";
    this.submissionId = id;
  }
}

// Journal before external writes. Unknown outcomes can only be reconciled, never replayed.
export class SubmissionJournal {
  constructor({ state, codex, logger }) {
    Object.assign(this, { state, codex, logger });
    this.running = new Map();
  }

  submit(id, context, execute) {
    if (this.running.has(id)) return this.running.get(id);
    const pending = this.run(id, context, execute).finally(() => this.running.delete(id));
    this.running.set(id, pending);
    return pending;
  }

  async run(id, context, execute) {
    const entries = this.state.state.submissions;
    let entry = entries[id];
    if (entry?.status === "submitted") return entry.result;
    if (entry && ["submitting", "unknown"].includes(entry.status)) throw new SubmissionPendingError(id);
    entry = entries[id] = { id, context: structuredClone(context), threadId: context.threadId ?? null,
      status: "submitting", startedAt: Date.now(), applied: false };
    await this.state.save();
    try {
      const result = await execute(async (threadId) => {
        entry.threadId = threadId;
        await this.state.save();
      });
      if (!(result?.turn?.id ?? result?.id)) throw new Error("Codex returned no turn ID");
      entry.result = structuredClone(result);
      entry.threadId ??= result.thread?.id;
      entry.status = "submitted";
      await this.state.save();
      return result;
    } catch (error) {
      // A returned application error or a write that was never sent may be retried.
      const rejected = ["rejected", "not_sent"].includes(error.requestOutcome) ||
        /already has an active writer|同步当前回合|找不到.*回合|expectedTurnId/i.test(error.message);
      entry.status = rejected ? "rejected" : "unknown";
      entry.method = error.requestMethod ?? null;
      entry.lastError = error.message;
      await this.state.save();
      if (!rejected) throw new SubmissionPendingError(id);
      throw error;
    }
  }

  async applied(id) {
    const entry = this.state.state.submissions[id];
    if (entry) entry.applied = true;
    await this.state.save();
  }

  async reconcile({ isApplying = () => false } = {}) {
    const recovered = [];
    for (const entry of Object.values(this.state.state.submissions)) {
      if ((entry.applied && !this.state.state.operations[entry.context.operationId]) || this.running.has(entry.id) || isApplying(entry)) continue;
      if (["submitting", "unknown"].includes(entry.status) && entry.threadId && entry.method !== "turn/steer") {
        try {
          const turn = await this.codex.findTurnByClientId(entry.threadId, entry.id);
          if (turn) {
            entry.result = entry.context.type === "create" ? {
              thread: { id: entry.threadId, cwd: entry.context.cwd, name: entry.context.name }, turn
            } : turn;
            entry.status = "submitted";
            await this.state.save();
          }
        } catch (error) {
          this.logger.warn("Submission reconciliation deferred", { submissionId: entry.id, error: error.message });
        }
      }
      if (entry.status === "submitted") recovered.push(entry);
    }
    return recovered;
  }
}
