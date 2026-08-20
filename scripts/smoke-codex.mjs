import { CodexClient } from "../src/codex-client.mjs";
import { loadConfig } from "../src/config.mjs";

const config = await loadConfig();
const client = new CodexClient({ bin: config.codexBin, socketPath: config.codexAppServerSocket });
client.on("log", (line) => console.error(line));

try {
  await client.start();
  const threads = await client.listThreads(3);
  console.log(JSON.stringify(threads.map(({ id, name, preview, status, cwd }) => ({ id, name, preview, status, cwd })), null, 2));
  if (threads[0]) {
    const thread = await client.readThread(threads[0].id);
    const turn = thread.turns?.at(-1);
    console.log(JSON.stringify({
      readThread: thread.id,
      status: thread.status,
      turnCount: thread.turns?.length ?? 0,
      latestTurn: turn ? { id: turn.id, status: turn.status, itemCount: turn.items?.length ?? 0 } : null
    }, null, 2));
    if (turn) {
      try {
        const page = await client.listThreadItems(thread.id, { turnId: turn.id, limit: 10, sortDirection: "desc" });
        console.log(JSON.stringify({
          detailItemsSource: "thread/items/list",
          detailItems: page.items.map((item) => ({ id: item.id, type: item.type, status: item.status ?? null })),
          hasOlderItems: Boolean(page.nextCursor)
        }, null, 2));
      } catch (error) {
        if (!/not supported yet|method not found|unknown method/i.test(error.message)) throw error;
        console.log(JSON.stringify({
          detailItemsSource: "thread/read fallback",
          detailItems: [...(turn.items ?? [])].reverse().slice(0, 10).map((item) => ({ id: item.id, type: item.type, status: item.status ?? null })),
          hasOlderItems: (turn.items?.length ?? 0) > 10
        }, null, 2));
      }
    }
  }
} finally {
  await client.stop();
}
