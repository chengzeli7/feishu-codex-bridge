import test from "node:test";
import assert from "node:assert/strict";
import { confirmedOutcome, finalAnswer, outcomeText } from "../src/turn-outcome.mjs";

test("terminal history requires an end timestamp or exact-turn authoritative evidence", () => {
  const turn = { id: "current", status: "interrupted", completedAt: null, items: [] };
  assert.equal(confirmedOutcome(turn), null);
  assert.equal(confirmedOutcome(turn, { rollout: { turnId: "old", status: "completed", result: "old answer" } }), null);
  assert.equal(confirmedOutcome({ ...turn, completedAt: 123 }).status, "interrupted");
  const settled = confirmedOutcome(turn, { rollout: { turnId: "current", status: "completed", result: "final" } });
  assert.equal(settled.status, "completed");
  assert.equal(settled.answer, "final");
  assert.equal(confirmedOutcome({ ...turn, status: "inProgress" }, { authoritative: true }), null);
});

test("final answer wins over progress, but text never converts failure into success", () => {
  const items = [
    { type: "agentMessage", phase: "commentary", text: "doing work" },
    { type: "agentMessage", phase: "final_answer", text: "final result" },
    { type: "agentMessage", phase: "commentary", text: "later progress" }
  ];
  assert.equal(finalAnswer({ items }), "final result");
  assert.equal(finalAnswer({ items: [items[0]] }), "");
  assert.equal(finalAnswer({ items: [{ type: "agentMessage", text: "legacy" }] }), "legacy");
  const failed = confirmedOutcome({ id: "turn", status: "failed", items }, { authoritative: true });
  assert.equal(failed.status, "failed");
  assert.equal(outcomeText(failed), "final result");
  assert.match(outcomeText({ status: "completed", answer: "" }), /未提供最终/);
  assert.match(outcomeText({ status: "interrupted", answer: "" }), /已停止/);
  assert.match(outcomeText({ status: "failed", answer: "" }), /执行失败/);
});
