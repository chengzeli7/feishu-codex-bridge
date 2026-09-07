import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { StateStore } from "../src/state-store.mjs";
import { SubmissionJournal, SubmissionPendingError } from "../src/submission-journal.mjs";

const logger = { warn() {} };
async function fixture(t, codex = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "bridge-journal-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const state = new StateStore(path.join(dir, "state.json")); await state.load();
  return { state, journal: new SubmissionJournal({ state, codex, logger }) };
}

test("an ambiguous turn start is matched after restart, never resubmitted", async (t) => {
  let executed = 0;
  const turn = { id: "turn", status: "completed", items: [{ type: "userMessage", clientId: "request" }] };
  const codex = { async findTurnByClientId(threadId, clientId) {
    assert.equal(threadId, "thread"); assert.equal(clientId, "request"); return turn;
  } };
  const { state, journal } = await fixture(t, codex);
  const execute = async (recordThread) => {
    executed += 1; await recordThread("thread");
    throw Object.assign(new Error("timeout"), { requestOutcome: "unknown", requestMethod: "turn/start" });
  };
  await assert.rejects(journal.submit("request", { type: "create", cwd: "/tmp/project" }, execute), SubmissionPendingError);
  const restored = new StateStore(state.filePath); await restored.load();
  const recovered = new SubmissionJournal({ state: restored, codex, logger });
  await assert.rejects(recovered.submit("request", {}, execute), SubmissionPendingError);
  const entries = await recovered.reconcile();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].result.thread.id, "thread");
  assert.equal(entries[0].result.turn.id, "turn");
  await recovered.submit("request", {}, execute);
  await recovered.applied("request");
  assert.deepEqual(await recovered.reconcile(), []);
  assert.equal(executed, 1);
});

test("missing history and steer without correlation remain unknown", async (t) => {
  let probes = 0;
  const { state, journal } = await fixture(t, { async findTurnByClientId() { probes += 1; return null; } });
  for (const [id, threadId, method] of [["no-thread", null, "thread/start"], ["steer", "thread", "turn/steer"], ["missing", "thread", "turn/start"]]) {
    await assert.rejects(journal.submit(id, { threadId }, async () => {
      throw Object.assign(new Error("disconnected"), { requestMethod: method, requestOutcome: "unknown" });
    }), SubmissionPendingError);
  }
  assert.deepEqual(await journal.reconcile(), []);
  assert.equal(probes, 1);
  assert.ok(Object.values(state.state.submissions).every((entry) => entry.status === "unknown"));
});

test("only definite rejection can be retried and concurrent callers share one write", async (t) => {
  const { journal } = await fixture(t);
  await assert.rejects(journal.submit("id", {}, async () => {
    throw Object.assign(new Error("denied"), { requestOutcome: "rejected" });
  }), /denied/);
  let writes = 0;
  const execute = async () => { writes += 1; return { id: "turn" }; };
  const results = await Promise.all([journal.submit("id", {}, execute), journal.submit("id", {}, execute)]);
  assert.deepEqual(results, [{ id: "turn" }, { id: "turn" }]);
  assert.equal(writes, 1);
});

test("recovery does not race an application still binding its successful turn", async (t) => {
  const { journal } = await fixture(t);
  await journal.submit("id", { threadId: "thread" }, async () => ({ id: "turn" }));
  assert.deepEqual(await journal.reconcile({ isApplying: () => true }), []);
  assert.equal((await journal.reconcile()).length, 1);
});
