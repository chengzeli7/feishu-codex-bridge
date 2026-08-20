import test from "node:test";
import assert from "node:assert/strict";
import { nextScheduleRun, parseScheduleExpression, scheduleLabel } from "../src/scheduler.mjs";

const now = new Date("2026-07-23T00:00:00.000Z");

test("parses daily, weekly and one-shot schedules in Asia/Shanghai", () => {
  const options = {
    now,
    timeZone: "Asia/Shanghai",
    defaultWorkspace: "android-main",
    detectWorkspace: (text) => text.includes("memory") ? "memory" : "android-main"
  };
  const daily = parseScheduleExpression("每天 09:00 android-main 检查 CI", options);
  assert.deepEqual(daily.spec, { kind: "daily", hour: 9, minute: 0 });
  assert.equal(new Date(daily.nextRunAt).toISOString(), "2026-07-23T01:00:00.000Z");

  const weekly = parseScheduleExpression("每周一 09:30 memory 汇总进度", options);
  assert.equal(weekly.workspace, "memory");
  assert.equal(scheduleLabel({ ...weekly, label: null }), "每周一 09:30");

  const once = parseScheduleExpression("30分钟后 android-main 检查告警", options);
  assert.equal(once.nextRunAt, now.getTime() + 30 * 60_000);
});

test("advances recurring schedules strictly after the reference time", () => {
  assert.equal(
    new Date(nextScheduleRun({ kind: "daily", hour: 8, minute: 0 }, now, "Asia/Shanghai")).toISOString(),
    "2026-07-24T00:00:00.000Z"
  );
  assert.throws(() => parseScheduleExpression("下个月检查 CI", { now, timeZone: "Asia/Shanghai", defaultWorkspace: "app" }), /无法识别/);
});
