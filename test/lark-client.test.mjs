import { EventEmitter } from "node:events";
import { existsSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import assert from "node:assert/strict";
import { LarkClient } from "../src/lark-client.mjs";

function waitFor(predicate, timeoutMs = 1_000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error("timed out"));
      setTimeout(tick, 10);
    };
    tick();
  });
}

test("keeps spooled events until the handler acknowledges them", async () => {
  const spoolRoot = await mkdtemp(path.join(os.tmpdir(), "lark-spool-"));
  let spawnOptions;
  let outputDirectory;
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;

  const lark = new LarkClient({
    spoolRoot,
    spawn(command, args, options) {
      assert.equal(command, "lark-cli");
      outputDirectory = args[args.indexOf("--output-dir") + 1];
      spawnOptions = options;
      return child;
    }
  });
  const envelopes = [];
  lark.on("event", (event) => envelopes.push(event));
  lark.on("exit", () => {});

  try {
    lark.startConsumer();
    const event = {
      type: "im.message.receive_v1",
      event_id: "event-1",
      message_id: "om_1",
      sender_type: "user",
      sender_id: "ou_1",
      chat_id: "oc_1",
      content: "任务"
    };
    const filePath = path.join(spawnOptions.cwd, outputDirectory, "event-1.json");
    writeFileSync(filePath, JSON.stringify(event));
    await waitFor(() => envelopes.length === 1);
    assert.equal(existsSync(filePath), true);
    envelopes[0].ack();
    await waitFor(() => !existsSync(filePath));
    assert.deepEqual(envelopes[0].event, event);
  } finally {
    await lark.stop();
    await rm(spoolRoot, { recursive: true, force: true });
  }
});

test("downloads resources in a message-scoped working directory", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lark-download-"));
  let captured;
  const lark = new LarkClient({
    spawn(command, args, options) {
      captured = { command, args, options };
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => true;
      queueMicrotask(() => {
        child.stdout.end('{"data":[{"resources":[{"local_path":"lark-im-resources/a.png"}]}]}');
        child.emit("exit", 0);
      });
      return child;
    }
  });
  try {
    const result = await lark.downloadMessageResources("om_test", directory);
    assert.equal(captured.command, "lark-cli");
    assert.equal(captured.options.cwd, directory);
    assert.ok(captured.args.includes("--download-resources"));
    assert.equal(result[0].resources[0].local_path, "lark-im-resources/a.png");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("streams PCM transcription payload through stdin instead of argv", async () => {
  let requestBody = "";
  const lark = new LarkClient({
    spawn(_command, args) {
      const child = new EventEmitter();
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => true;
      child.stdin.on("data", (chunk) => { requestBody += chunk; });
      child.stdin.on("end", () => {
        child.stdout.end('{"data":{"recognition_text":"检查完成"}}');
        child.emit("exit", 0);
      });
      assert.equal(args[0], "api");
      assert.equal(args.at(-1), "-");
      return child;
    }
  });
  const result = await lark.transcribePcm("cGNt", "1234567890abcdef");
  assert.equal(result.recognition_text, "检查完成");
  assert.equal(JSON.parse(requestBody).speech.speech, "cGNt");
});
