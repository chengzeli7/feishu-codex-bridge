import { open, stat } from "node:fs/promises";

function messageText(content) {
  if (!Array.isArray(content)) return "";
  return content
    .filter((item) => item && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n")
    .trim();
}

export async function readRolloutSnapshot(filePath, {
  now = Date.now(),
  staleAfterMs = 10 * 60_000,
  maxBytes = 4 * 1024 * 1024
} = {}) {
  if (!filePath) return null;
  const fileStat = await stat(filePath);
  const size = Math.min(fileStat.size, maxBytes);
  const offset = Math.max(0, fileStat.size - size);
  const handle = await open(filePath, "r");
  let text;
  try {
    const buffer = Buffer.alloc(size);
    await handle.read(buffer, 0, size, offset);
    text = buffer.toString("utf8");
  } finally {
    await handle.close();
  }

  if (offset > 0) text = text.slice(text.indexOf("\n") + 1);
  const events = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // A concurrently appended final line may be incomplete; the next poll will read it.
    }
  }

  let current = null;
  for (const event of events) {
    if (event.type === "turn_context" && event.payload?.turn_id) {
      current = {
        turnId: event.payload.turn_id,
        startedAt: event.timestamp ?? null,
        lastEventAt: event.timestamp ?? null,
        status: "inProgress",
        progress: "",
        result: ""
      };
      continue;
    }
    if (!current) continue;
    current.lastEventAt = event.timestamp ?? current.lastEventAt;

    if (event.type === "response_item" && event.payload?.type === "message" && event.payload.role === "assistant") {
      const textValue = messageText(event.payload.content);
      if (event.payload.phase === "commentary" && textValue) current.progress = textValue;
      if (event.payload.phase === "final_answer" && textValue) current.result = textValue;
    }

    if (event.type === "event_msg" && event.payload?.type === "task_complete" && event.payload.turn_id === current.turnId) {
      current.status = "completed";
      current.result = event.payload.last_agent_message?.trim() || current.result;
      current.completedAt = event.payload.completed_at ?? null;
    }
  }

  if (!current) return null;
  const fresh = now - fileStat.mtimeMs <= staleAfterMs;
  if (current.status === "inProgress" && !fresh) current.status = "unknown";
  return { ...current, filePath, mtimeMs: fileStat.mtimeMs };
}
