import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import assert from "node:assert/strict";
import { CodexClient, userInput } from "../src/codex-client.mjs";
import { VERSION } from "../src/version.mjs";

test("restores a task unloaded between read and write once with the same input identity", async () => {
  const client = new CodexClient({});
  const requests = [];
  client.request = async (method, params) => {
    requests.push({ method, params });
    if (method === "thread/resume") return { thread: { id: "thread", cwd: "/tmp/project", status: { type: "idle" } } };
    if (requests.length === 1) throw Object.assign(new Error("thread not found: thread"), { requestOutcome: "rejected" });
    return { turn: { id: "next" } };
  };
  const options = { clientUserMessageId: "request", attachments: [{ kind: "image", path: "/tmp/image.png" }] };
  const result = await client.sendMessage("thread", "continue", { id: "thread", cwd: "/tmp/project", status: { type: "idle" } }, options);
  assert.equal(result.id, "next");
  assert.deepEqual(requests.map((item) => item.method), ["turn/start", "thread/resume", "turn/start"]);
  assert.deepEqual(requests[0].params, requests[2].params);
});

test("never replays an uncertain start and bounds missing-thread recovery to one attempt", async () => {
  for (const outcome of ["unknown", "rejected"]) {
    const client = new CodexClient({});
    const requests = [];
    client.request = async (method) => {
      requests.push(method);
      if (method === "thread/resume") return { thread: { id: "thread", status: { type: "idle" } } };
      throw Object.assign(new Error("thread not found: thread"), { requestOutcome: outcome });
    };
    await assert.rejects(client.sendMessage("thread", "continue", { id: "thread", status: { type: "idle" } }), /thread not found/);
    assert.deepEqual(requests, outcome === "unknown" ? ["turn/start"] : ["turn/start", "thread/resume", "turn/start"]);
  }
});

test("queued restoration waits for a newer turn instead of steering or starting it", async () => {
  for (const initialStatus of ["notLoaded", "idle"]) {
    const client = new CodexClient({});
    const requests = [];
    client.request = async (method) => {
      requests.push(method);
      if (method === "turn/start") throw Object.assign(new Error("thread not found: thread"), { requestOutcome: "rejected" });
      assert.equal(method, "thread/resume");
      return { thread: { id: "thread", status: { type: "active" }, turns: [{ id: "newer", status: "inProgress" }] } };
    };
    await assert.rejects(client.sendMessage("thread", "queued", { id: "thread", status: { type: initialStatus } }, {
      completedTurnId: "old", clientUserMessageId: "request"
    }), (error) => error.code === "QUEUE_TURN_ACTIVE" && error.requestOutcome === "not_sent");
    assert.deepEqual(requests, initialStatus === "notLoaded" ? ["thread/resume"] : ["turn/start", "thread/resume"]);
  }
});

test("terminal evidence overrides only the watched turn after resume", async () => {
  const client = new CodexClient({});
  const requests = [];
  client.request = async (method) => {
    requests.push(method);
    if (method === "thread/resume") return { thread: { id: "thread", status: { type: "active" },
      turns: [{ id: "old", status: "inProgress" }] } };
    assert.equal(method, "turn/start");
    return { turn: { id: "next" } };
  };
  assert.equal((await client.sendMessage("thread", "queued", { status: { type: "notLoaded" } }, { completedTurnId: "old" })).id, "next");
  assert.deepEqual(requests, ["thread/resume", "turn/start"]);
});

test("a direct start rejected before resume never steers a newly active turn", async () => {
  const client = new CodexClient({});
  const requests = [];
  client.request = async (method) => {
    requests.push(method);
    if (method === "turn/start") throw Object.assign(new Error("thread not found: thread"), { requestOutcome: "rejected" });
    return { thread: { id: "thread", status: { type: "active" }, turns: [{ id: "new", status: "inProgress" }] } };
  };
  await assert.rejects(client.sendMessage("thread", "continue", { status: { type: "idle" } }),
    (error) => error.code === "QUEUE_TURN_ACTIVE" && error.requestOutcome === "not_sent");
  assert.deepEqual(requests, ["turn/start", "thread/resume"]);
});

test("reconciliation pages read-only history and matches clientId exactly", async () => {
  const client = new CodexClient({});
  const requests = [];
  client.request = async (method, params) => {
    requests.push({ method, params });
    return params.cursor ? { data: [{ id: "match", items: [{ type: "userMessage", clientId: "request" }] }] } :
      { data: [{ id: "wrong", items: [{ type: "userMessage", clientId: "request-other" }] }], nextCursor: "page2" };
  };
  assert.equal((await client.findTurnByClientId("thread", "request")).id, "match");
  assert.equal(requests.length, 2);
  assert.ok(requests.every((item) => item.method === "thread/turns/list"));
  assert.equal(requests[1].params.cursor, "page2");
  client.request = async () => ({ data: [], nextCursor: "repeated" });
  assert.equal(await client.findTurnByClientId("thread", "missing"), null);
});

test("request errors distinguish unsent writes from uncertain timeouts and RPC rejection", async () => {
  const socket = new EventEmitter(); socket.readyState = 1; socket.close = () => {};
  socket.send = (serialized) => {
    const request = JSON.parse(serialized);
    if (request.method === "initialize") queueMicrotask(() => socket.emit("message", Buffer.from(JSON.stringify({ id: request.id, result: {} }))));
    if (request.method === "denied") queueMicrotask(() => socket.emit("message", Buffer.from(JSON.stringify({ id: request.id, error: { code: -32602, message: "invalid input" } }))));
    if (request.method === "internal") queueMicrotask(() => socket.emit("message", Buffer.from(JSON.stringify({ id: request.id, error: { code: -32603, message: "internal error after dispatch" } }))));
  };
  const client = new CodexClient({ socketPath: "/tmp/test.sock", requestTimeoutMs: 20, createWebSocket: () => {
    queueMicrotask(() => socket.emit("open")); return socket;
  } });
  await assert.rejects(client.request("turn/start", {}), (error) => error.requestOutcome === "not_sent");
  await client.start();
  try {
    await assert.rejects(client.request("denied", {}), (error) => error.requestOutcome === "rejected" && error.rpcCode === -32602);
    await assert.rejects(client.request("internal", {}), (error) => error.requestOutcome === "unknown");
    await assert.rejects(client.request("turn/start", {}, 20), (error) => error.requestOutcome === "unknown" && error.requestMethod === "turn/start");
  } finally { await client.stop(); }
});

test("connects to the shared Desktop app-server over a Unix WebSocket", async () => {
  const sent = [];
  const socket = new EventEmitter();
  socket.readyState = 0;
  socket.send = (serialized) => {
    const request = JSON.parse(serialized);
    sent.push(request);
    if (request.method === "initialize") {
      queueMicrotask(() => socket.emit("message", Buffer.from(JSON.stringify({ id: request.id, result: {} }))));
    }
  };
  socket.close = () => { socket.readyState = 3; };
  const client = new CodexClient({
    socketPath: "/tmp/codex-app-server.sock",
    createWebSocket(socketPath) {
      assert.equal(socketPath, "/tmp/codex-app-server.sock");
      queueMicrotask(() => {
        socket.readyState = 1;
        socket.emit("open");
      });
      return socket;
    },
    spawn: () => { throw new Error("stdio app-server must not be spawned"); }
  });
  try {
    await client.start();
    assert.equal(client.ready, true);
    assert.equal(sent[0].method, "initialize");
    assert.equal(sent[0].params.clientInfo.version, VERSION);
    assert.equal(sent[1].method, "initialized");
  } finally {
    await client.stop();
  }
});

test("builds Codex input for images and readable file attachments", () => {
  assert.deepEqual(userInput("分析附件", [
    { kind: "image", name: "screen.png", path: "/tmp/attachments/screen.png" },
    { kind: "file", name: "report.pdf", path: "/tmp/attachments/report.pdf" }
  ]), [
    {
      type: "text",
      text: "分析附件\n\n飞书附件已保存到以下受限本机路径，请读取后完成任务：\n- report.pdf: /tmp/attachments/report.pdf",
      text_elements: []
    },
    { type: "localImage", path: "/tmp/attachments/screen.png" }
  ]);
});

test("cleans up a failed shared app-server connection so reconnect can retry", async () => {
  let attempts = 0;
  const client = new CodexClient({
    socketPath: "/tmp/missing-codex-app-server.sock",
    createWebSocket() {
      attempts += 1;
      const socket = new EventEmitter();
      socket.readyState = 0;
      socket.close = () => { socket.readyState = 3; };
      queueMicrotask(() => socket.emit("error", new Error("connect ENOENT")));
      return socket;
    }
  });
  await assert.rejects(client.start(), /ENOENT/);
  await assert.rejects(client.start(), /ENOENT/);
  assert.equal(attempts, 2);
});

test("creates a persisted task in a constrained workspace", async () => {
  const requests = [];
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  child.stdin.on("data", (chunk) => {
    for (const line of chunk.toString().trim().split("\n")) {
      const request = JSON.parse(line);
      if (!Object.hasOwn(request, "id")) continue;
      requests.push(request);
      let result = {};
      if (request.method === "initialize") result = {};
      if (request.method === "thread/start") result = { thread: { id: "thread-1", cwd: request.params.cwd, status: { type: "idle" }, turns: [] } };
      if (request.method === "turn/start") result = { turn: { id: "turn-1", status: "inProgress", items: [] } };
      queueMicrotask(() => child.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`));
    }
  });
  const client = new CodexClient({ spawn: () => child, bin: "/bin/codex" });
  try {
    await client.start();
    const created = await client.createTask({ cwd: "/tmp/project", prompt: "完成任务", name: "任务名称", effort: "high" });
    assert.equal(created.thread.id, "thread-1");
    assert.equal(created.turn.id, "turn-1");
    const start = requests.find((item) => item.method === "thread/start");
    assert.equal(start.params.approvalPolicy, "never");
    assert.deepEqual(start.params.runtimeWorkspaceRoots, ["/tmp/project"]);
    const turn = requests.find((item) => item.method === "turn/start");
    assert.equal(turn.params.effort, "high");
    assert.ok(requests.some((item) => item.method === "thread/name/set"));
  } finally {
    await client.stop();
  }
});

test("refreshes an active task summary before steering the current turn", async () => {
  const requests = [];
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  child.stdin.on("data", (chunk) => {
    for (const line of chunk.toString().trim().split("\n")) {
      const request = JSON.parse(line);
      if (!Object.hasOwn(request, "id")) continue;
      requests.push(request);
      let result = {};
      if (request.method === "thread/read") {
        result = { thread: { id: "thread-1", status: { type: "active" }, turns: [{ id: "turn-live", status: "inProgress", items: [] }] } };
      }
      if (request.method === "turn/steer") result = { turnId: "turn-live" };
      queueMicrotask(() => child.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`));
    }
  });
  const client = new CodexClient({ spawn: () => child, bin: "/bin/codex" });
  try {
    await client.start();
    const turn = await client.sendMessage("thread-1", "补充要求", { id: "thread-1", status: { type: "active" } });
    assert.equal(turn.steered, true);
    assert.ok(requests.some((item) => item.method === "thread/read"));
    const steer = requests.find((item) => item.method === "turn/steer");
    assert.equal(steer.params.expectedTurnId, "turn-live");
  } finally {
    await client.stop();
  }
});

test("unarchives a closed task before starting its next turn", async () => {
  const requests = [];
  let resumeAttempts = 0;
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  child.stdin.on("data", (chunk) => {
    for (const line of chunk.toString().trim().split("\n")) {
      const request = JSON.parse(line);
      if (!Object.hasOwn(request, "id")) continue;
      requests.push(request);
      let response = { id: request.id, result: {} };
      if (request.method === "thread/resume") {
        resumeAttempts += 1;
        response = resumeAttempts === 1 ? {
          id: request.id,
          error: { message: "session thread-1 is archived. Run `codex unarchive thread-1` to unarchive it first." }
        } : {
          id: request.id,
          result: { thread: { id: "thread-1", cwd: "/tmp/project", status: { type: "idle" }, turns: [] } }
        };
      }
      if (request.method === "thread/unarchive") {
        response = { id: request.id, result: { thread: { id: "thread-1", status: { type: "notLoaded" }, turns: [] } } };
      }
      if (request.method === "turn/start") {
        response = { id: request.id, result: { turn: { id: "turn-restored", status: "inProgress", items: [] } } };
      }
      queueMicrotask(() => child.stdout.write(`${JSON.stringify(response)}\n`));
    }
  });
  const client = new CodexClient({ spawn: () => child, bin: "/bin/codex" });
  try {
    await client.start();
    const turn = await client.sendMessage("thread-1", "继续处理", {
      id: "thread-1",
      status: { type: "notLoaded" },
      turns: []
    });
    assert.equal(turn.id, "turn-restored");
    assert.deepEqual(requests.map((item) => item.method), [
      "initialize",
      "thread/resume",
      "thread/unarchive",
      "thread/resume",
      "turn/start"
    ]);
  } finally {
    await client.stop();
  }
});

test("does not duplicate a continuation when another process owns the writer", async () => {
  const requests = [];
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  child.stdin.on("data", (chunk) => {
    for (const line of chunk.toString().trim().split("\n")) {
      const request = JSON.parse(line);
      if (!Object.hasOwn(request, "id")) continue;
      requests.push(request);
      let response = { id: request.id, result: {} };
      if (request.method === "thread/resume") {
        response = { id: request.id, error: { message: "thread thread-1 already has an active writer" } };
      }
      queueMicrotask(() => child.stdout.write(`${JSON.stringify(response)}\n`));
    }
  });
  const client = new CodexClient({ spawn: () => child, bin: "/bin/codex" });
  try {
    await client.start();
    await assert.rejects(client.sendMessage("thread-1", "停止后继续", {
      id: "thread-1",
      status: { type: "notLoaded" },
      turns: [{ id: "turn-stopped", status: "interrupted", items: [] }]
    }, { clientUserMessageId: "om_continue" }), /already has an active writer/);
    assert.deepEqual(requests.map((item) => item.method), [
      "initialize",
      "thread/resume"
    ]);
  } finally {
    await client.stop();
  }
});

test("unsubscribes a completed task to release its writer", async () => {
  const requests = [];
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  child.stdin.on("data", (chunk) => {
    for (const line of chunk.toString().trim().split("\n")) {
      const request = JSON.parse(line);
      if (!Object.hasOwn(request, "id")) continue;
      requests.push(request);
      const result = request.method === "thread/unsubscribe" ? { status: "unsubscribed" } : {};
      queueMicrotask(() => child.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`));
    }
  });
  const client = new CodexClient({ spawn: () => child, bin: "/bin/codex" });
  try {
    await client.start();
    const result = await client.unsubscribeThread("thread-1");
    assert.equal(result.status, "unsubscribed");
    assert.deepEqual(requests.find((item) => item.method === "thread/unsubscribe")?.params, {
      threadId: "thread-1"
    });
  } finally {
    await client.stop();
  }
});

test("uses the known turn id while an active task detail is still syncing", async () => {
  const requests = [];
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  child.stdin.on("data", (chunk) => {
    for (const line of chunk.toString().trim().split("\n")) {
      const request = JSON.parse(line);
      if (!Object.hasOwn(request, "id")) continue;
      requests.push(request);
      let result = {};
      if (request.method === "thread/read") result = { thread: { id: "thread-1", status: { type: "active" }, turns: [] } };
      if (request.method === "turn/steer") result = { turnId: "turn-known" };
      queueMicrotask(() => child.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`));
    }
  });
  const client = new CodexClient({ spawn: () => child, bin: "/bin/codex" });
  try {
    await client.start();
    await client.sendMessage("thread-1", "补充要求", { id: "thread-1", status: { type: "active" }, turns: [] }, { expectedTurnId: "turn-known" });
    const steer = requests.find((item) => item.method === "turn/steer");
    assert.equal(steer.params.expectedTurnId, "turn-known");
  } finally {
    await client.stop();
  }
});

test("retries a transient empty rollout while reading task detail", async () => {
  let readAttempts = 0;
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  child.stdin.on("data", (chunk) => {
    for (const line of chunk.toString().trim().split("\n")) {
      const request = JSON.parse(line);
      if (!Object.hasOwn(request, "id")) continue;
      if (request.method !== "thread/read") {
        queueMicrotask(() => child.stdout.write(`${JSON.stringify({ id: request.id, result: {} })}\n`));
        continue;
      }
      readAttempts += 1;
      const response = readAttempts === 1 ?
        { id: request.id, error: { message: "failed to read session metadata: rollout is empty" } } :
        { id: request.id, result: { thread: { id: "thread-1", status: { type: "idle" }, turns: [] } } };
      queueMicrotask(() => child.stdout.write(`${JSON.stringify(response)}\n`));
    }
  });
  const client = new CodexClient({ spawn: () => child, bin: "/bin/codex" });
  try {
    await client.start();
    const thread = await client.readThread("thread-1");
    assert.equal(thread.id, "thread-1");
    assert.equal(readAttempts, 2);
  } finally {
    await client.stop();
  }
});

test("lists a paged turn activity feed", async () => {
  const requests = [];
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  child.stdin.on("data", (chunk) => {
    for (const line of chunk.toString().trim().split("\n")) {
      const request = JSON.parse(line);
      if (!Object.hasOwn(request, "id")) continue;
      requests.push(request);
      const result = request.method === "thread/items/list" ? {
        data: [{ id: "command", type: "commandExecution", command: "npm test", status: "completed" }],
        nextCursor: "older-cursor",
        backwardsCursor: null
      } : {};
      queueMicrotask(() => child.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`));
    }
  });
  const client = new CodexClient({ spawn: () => child, bin: "/bin/codex" });
  try {
    await client.start();
    const page = await client.listThreadItems("thread-1", {
      turnId: "turn-1",
      limit: 10,
      sortDirection: "desc"
    });
    assert.equal(page.items[0].id, "command");
    assert.equal(page.nextCursor, "older-cursor");
    const request = requests.find((item) => item.method === "thread/items/list");
    assert.equal(request.params.turnId, "turn-1");
    assert.equal(request.params.sortDirection, "desc");
  } finally {
    await client.stop();
  }
});
