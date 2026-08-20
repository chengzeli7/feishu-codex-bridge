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
