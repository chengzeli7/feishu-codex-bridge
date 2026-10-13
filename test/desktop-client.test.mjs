import test from "node:test";
import assert from "node:assert/strict";
import { DesktopClient, DesktopContinuation, desktopBusy, desktopInput } from "../src/desktop-client.mjs";
import { CodexClient } from "../src/codex-client.mjs";

const idle = { resumeState: "resumed", threadRuntimeStatus: { type: "idle" }, requests: [] };

test("Desktop optimistic rendering always receives text_elements before submission", async () => {
  const client = new DesktopClient({ socketPath: "/unused" });
  const requests = [];
  client.request = async (method, params) => {
    requests.push({ method, params });
    for (const item of params.turnStart.request.input) {
      if (item.type === "text") assert.equal(item.text_elements.length, 0);
    }
    return { result: { turn: { id: "turn" } } };
  };
  for (const input of [undefined, [{ type: "text", text: "plain" }], [{ type: "text", text: "nullable", text_elements: null }],
    [{ type: "text", text: "image" }, { type: "localImage", path: "/tmp/image.png" }]]) {
    await client.startTurn("thread", "fallback", "stable-message", "owner", { input });
  }
  assert.equal(requests.length, 4);
  assert.ok(requests.every((x) => x.params.turnStart.request.clientUserMessageId === "stable-message"));
  assert.equal(requests.at(-1).params.turnStart.request.input[1].path, "/tmp/image.png");
  await assert.rejects(client.startTurn("thread", "bad", "stable-message", "owner", {
    input: [{ type: "text", text: "bad", text_elements: {} }]
  }), (error) => error.requestOutcome === "not_sent");
  assert.equal(requests.length, 4);
});

test("Desktop input normalization preserves existing text metadata and does not mutate callers", () => {
  const original = { type: "text", text: "hello", text_elements: [{ byteRange: { start: 0, end: 5 }, placeholder: "hello" }] };
  assert.deepEqual(desktopInput([original]), [original]);
  const plain = { type: "text", text: "plain" };
  assert.deepEqual(desktopInput([plain]), [{ ...plain, text_elements: [] }]);
  assert.equal(Object.hasOwn(plain, "text_elements"), false);
});

test("a writer conflict routes the original submission to the Desktop owner without unsubscribe", async () => {
  const calls = [];
  const client = new CodexClient({ desktop: { sendMessage: async (...args) => {
    calls.push({ method: "desktop", args }); return { id: "owner-turn", desktopOwned: true };
  } } });
  client.request = async (method) => {
    calls.push({ method });
    throw Object.assign(new Error("thread id already has an active writer"), { requestOutcome: "rejected" });
  };
  const turn = await client.sendMessage("id", "continue", { status: { type: "notLoaded" } }, {
    clientUserMessageId: "same-id", attachments: [{ kind: "image", path: "/tmp/test.png" }]
  });
  assert.equal(turn.id, "owner-turn");
  assert.deepEqual(calls.map((x) => x.method), ["thread/resume", "desktop"]);
  assert.equal(calls[1].args[2].clientUserMessageId, "same-id");
  assert.equal(calls[1].args[2].approvalPolicy, "never");
  assert.equal(calls[1].args[2].input[1].path, "/tmp/test.png");
});

test("Desktop recovery only applies to definite writer conflict, not uncertain writes", async () => {
  const client = new CodexClient({ desktop: { sendMessage: () => assert.fail("must not replay") } });
  client.request = async () => { throw Object.assign(new Error("request timed out"), { requestOutcome: "unknown" }); };
  await assert.rejects(client.sendMessage("id", "continue", { status: { type: "idle" } }), /timed out/);
});

test("owner routing checks live approvals, new turns and resume state before writing", async () => {
  for (const state of [undefined, {}, { ...idle, requests: [{}] }, { ...idle, resumeState: "needs_resume" },
    { ...idle, threadRuntimeStatus: { type: "active" } }, { ...idle, unconfirmedTurnSubmissions: [{}] }]) {
    let closed = false;
    const adapter = new DesktopContinuation({ createClient: () => ({
      start: async () => {}, snapshot: async () => ({ state, ownerId: "owner" }),
      startTurn: () => assert.fail("must not interrupt a busy owner"), stop: () => { closed = true; }
    }) });
    await assert.rejects(adapter.sendMessage("id", "text"), (error) => error.code === "QUEUE_TURN_ACTIVE" && error.requestOutcome === "not_sent");
    assert.equal(closed, true);
  }
  assert.equal(desktopBusy(idle), false);
});

test("owner start preserves identity and a disconnect after start is never replayed", async () => {
  let writes = 0;
  const adapter = new DesktopContinuation({ createClient: () => ({ start: async () => {},
    snapshot: async () => ({ state: idle, ownerId: "owner" }), stop: () => {},
    startTurn: async (thread, text, id, owner, options) => {
      writes += 1; assert.equal(id, "request"); assert.equal(owner, "owner");
      assert.equal(options.approvalPolicy, "never"); throw new Error("connection lost");
    }
  }) });
  await assert.rejects(adapter.sendMessage("id", "text", { clientUserMessageId: "request" }),
    (error) => error.requestOutcome === "unknown" && error.requestMethod === "turn/start");
  assert.equal(writes, 1);
});

test("missing task owner is prepared once, then its snapshot is retried without user input", async () => {
  let reads = 0, wakes = 0;
  const client = new DesktopClient({ socketPath: "/unused", wakeThread: async (id) => { assert.equal(id, "task"); wakes += 1; } });
  client.readSnapshot = async () => { if (++reads < 2) throw new Error("no-client-found"); return { state: idle, ownerId: "owner" }; };
  assert.equal((await client.snapshot("task")).ownerId, "owner");
  assert.equal(wakes, 1); assert.equal(reads, 2);
});
