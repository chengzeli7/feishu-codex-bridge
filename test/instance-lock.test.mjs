import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { InstanceLock } from "../src/instance-lock.mjs";

test("recovers a stale lock and rejects a live duplicate", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bridge-lock-"));
  const file = path.join(directory, "bridge.lock");
  await writeFile(file, "99999999\n");
  const first = new InstanceLock(file);
  try {
    await first.acquire();
    assert.equal(existsSync(file), true);
    const second = new InstanceLock(file);
    await assert.rejects(second.acquire(), /已经在运行/);
  } finally {
    await first.release();
    assert.equal(existsSync(file), false);
    await rm(directory, { recursive: true, force: true });
  }
});
