import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { readRolloutSnapshot } from "../src/rollout-monitor.mjs";

test("reads live commentary and task completion from a rollout", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rollout-monitor-"));
  const file = path.join(dir, "rollout.jsonl");
  const events = [
    { timestamp: "2026-07-17T08:00:00Z", type: "turn_context", payload: { turn_id: "turn-1" } },
    { timestamp: "2026-07-17T08:00:01Z", type: "response_item", payload: { type: "message", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: "正在跑测试" }] } }
  ];
  await writeFile(file, `${events.map(JSON.stringify).join("\n")}\n`);

  try {
    const active = await readRolloutSnapshot(file);
    assert.equal(active.status, "inProgress");
    assert.equal(active.progress, "正在跑测试");

    events.push({
      timestamp: "2026-07-17T08:00:02Z",
      type: "event_msg",
      payload: { type: "task_complete", turn_id: "turn-1", last_agent_message: "测试通过" }
    });
    await writeFile(file, `${events.map(JSON.stringify).join("\n")}\n`);
    const completed = await readRolloutSnapshot(file);
    assert.equal(completed.status, "completed");
    assert.equal(completed.result, "测试通过");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("infers the current turn when a large rollout tail excludes turn context", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rollout-monitor-tail-"));
  const file = path.join(dir, "rollout.jsonl");
  const events = [
    { timestamp: "2026-08-31T11:00:00Z", type: "turn_context", payload: { turn_id: "turn-large" } },
    { timestamp: "2026-08-31T11:00:01Z", type: "response_item", payload: { type: "reasoning", summary: ["x".repeat(2_000)] } },
    { timestamp: "2026-08-31T11:00:02Z", type: "event_msg", payload: { type: "item_completed", turn_id: "turn-large" } },
    { timestamp: "2026-08-31T11:00:03Z", type: "response_item", payload: { type: "message", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: "继续处理" }] } }
  ];
  await writeFile(file, `${events.map(JSON.stringify).join("\n")}\n`);

  try {
    const active = await readRolloutSnapshot(file, { maxBytes: 800 });
    assert.equal(active.turnId, "turn-large");
    assert.equal(active.status, "inProgress");
    assert.equal(active.progress, "继续处理");

    events.push({
      timestamp: "2026-08-31T11:00:04Z",
      type: "event_msg",
      payload: { type: "task_complete", turn_id: "turn-large", last_agent_message: "处理完成" }
    });
    await writeFile(file, `${events.map(JSON.stringify).join("\n")}\n`);
    const completed = await readRolloutSnapshot(file, { maxBytes: 800 });
    assert.equal(completed.turnId, "turn-large");
    assert.equal(completed.status, "completed");
    assert.equal(completed.result, "处理完成");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("maps an aborted rollout turn to interrupted instead of leaving it unloaded", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rollout-monitor-aborted-"));
  const file = path.join(dir, "rollout.jsonl");
  const events = [
    { timestamp: "2026-09-01T10:18:44Z", type: "event_msg", payload: { type: "item_completed", turn_id: "turn-aborted" } },
    { timestamp: "2026-09-01T10:18:45Z", type: "response_item", payload: { type: "message", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: "正在复测" }] } },
    { timestamp: "2026-09-01T10:19:03Z", type: "event_msg", payload: { type: "turn_aborted", turn_id: "turn-aborted", reason: "interrupted", completed_at: 1_788_257_943 } }
  ];
  await writeFile(file, `${events.map(JSON.stringify).join("\n")}\n`);

  try {
    const snapshot = await readRolloutSnapshot(file, { now: Date.parse("2026-09-02T10:19:03Z") });
    assert.equal(snapshot.turnId, "turn-aborted");
    assert.equal(snapshot.status, "interrupted");
    assert.equal(snapshot.progress, "正在复测");
    assert.equal(snapshot.completedAt, 1_788_257_943);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
