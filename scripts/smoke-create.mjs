import { setTimeout as delay } from "node:timers/promises";
import { loadConfig } from "../src/config.mjs";
import { CodexClient, latestAgentMessage, latestTurn } from "../src/codex-client.mjs";

const config = await loadConfig();
const workspaceAlias = process.argv[2] ?? "flow-main";
const cwd = config.workspaces[workspaceAlias];
if (!cwd) throw new Error(`unknown workspace alias: ${workspaceAlias}`);

const client = new CodexClient({ bin: config.codexBin, socketPath: config.codexAppServerSocket, requestTimeoutMs: 30_000 });
client.on("log", (line) => console.error(line));

try {
  await client.start();
  const created = await client.createTask({
    cwd,
    name: "Feishu Codex Bridge v0.1.2 smoke test",
    prompt: "This is the Feishu Codex Bridge v0.1.2 task creation smoke test. Do not modify files. Reply exactly: create smoke passed",
    effort: "medium"
  });
  console.log(`created thread ${created.thread.id}`);
  console.log(`created turn ${created.turn.id}`);
  const deadline = Date.now() + 120_000;
  let finished = false;
  while (Date.now() < deadline) {
    const thread = await client.readThread(created.thread.id);
    const turn = latestTurn(thread);
    if (turn && turn.status !== "inProgress") {
      console.log(`turn status ${turn.status}`);
      console.log(latestAgentMessage(thread));
      if (turn.status !== "completed") process.exitCode = 1;
      finished = true;
      break;
    }
    await delay(2_000);
  }
  if (!finished) throw new Error("create smoke timed out");
} finally {
  await client.stop();
}
