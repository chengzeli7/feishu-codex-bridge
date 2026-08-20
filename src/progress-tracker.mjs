import path from "node:path";

const MAX_TRACKED_TURNS = 100;
const MAX_TRACKED_ITEMS = 200;
const MAX_DELTA_TEXT = 4_000;

const STATUS_LABELS = {
  inProgress: "运行中",
  completed: "已完成",
  failed: "失败",
  declined: "已拒绝",
  interrupted: "已中断",
  pending: "等待中"
};

function normalizedTimestamp(value) {
  if (!value) return null;
  const number = Number(value);
  if (Number.isFinite(number)) return number < 1_000_000_000_000 ? number * 1000 : number;
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? null : parsed;
}

function trimmedTail(value, max = MAX_DELTA_TEXT) {
  const text = String(value ?? "");
  return text.length <= max ? text : text.slice(-max);
}

export function redactSensitive(value = "") {
  return String(value)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:sk|xox[baprs]|gh[pousr])[-_][A-Za-z0-9_-]{12,}\b/gi, "[REDACTED]")
    .replace(/((?:authorization|password|passwd|secret|token|api[_-]?key|cookie|private[_-]?key)\s*["']?\s*[:=]\s*["']?)([^"'\s,;&]+)/gi, "$1[REDACTED]")
    .replace(/([?&](?:access_token|token|api_key|key|secret|password)=)[^&#\s]+/gi, "$1[REDACTED]")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

function displayText(value, max = 360) {
  const text = redactSensitive(value).replaceAll(/\s+/g, " ").trim();
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function statusOf(item, fallback = "completed") {
  return item?.status ?? fallback;
}

function statusLabel(status) {
  return STATUS_LABELS[status] ?? status ?? "未知";
}

function relativeFilePath(cwd, filePath) {
  if (!filePath) return "未知文件";
  if (!cwd || !path.isAbsolute(filePath)) return displayText(filePath, 180);
  const relative = path.relative(cwd, filePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return path.basename(filePath);
  return displayText(relative, 180);
}

function fileChangeKind(change) {
  return typeof change?.kind === "string" ? change.kind : change?.kind?.type ?? "update";
}

function activityFromItem(item, { cwd, liveMeta } = {}) {
  if (!item?.type || item.type === "reasoning" || item.type === "plan" || item.type === "userMessage") return null;
  const base = {
    id: item.id ?? `${item.type}-unknown`,
    type: item.type,
    status: statusOf(item),
    statusLabel: statusLabel(statusOf(item)),
    updatedAt: liveMeta?.updatedAt ?? null,
    durationMs: item.durationMs ?? null,
    error: null
  };

  if (item.type === "agentMessage") {
    const final = item.phase === "final_answer";
    return {
      ...base,
      category: "Codex",
      label: final ? "最终回复" : "进度说明",
      detail: displayText(item.text, 520),
      status: final ? "completed" : statusOf(item, "completed"),
      statusLabel: final ? "已完成" : statusLabel(statusOf(item, "completed"))
    };
  }

  if (item.type === "commandExecution") {
    const errorOutput = item.status === "failed" ? trimmedTail(item.aggregatedOutput, 800) : "";
    return {
      ...base,
      category: "命令",
      label: item.status === "inProgress" ? "正在执行命令" : "命令执行",
      detail: displayText(item.command, 420),
      meta: item.exitCode == null ? null : `退出码 ${item.exitCode}`,
      error: errorOutput ? displayText(errorOutput, 420) : null
    };
  }

  if (item.type === "mcpToolCall") {
    return {
      ...base,
      category: "MCP",
      label: `${displayText(item.server, 80)}/${displayText(item.tool, 100)}`,
      detail: item.progressMessage ? displayText(item.progressMessage, 420) : item.status === "inProgress" ? "正在等待工具返回" : "工具调用已结束",
      error: item.error?.message ? displayText(item.error.message, 420) : null
    };
  }

  if (item.type === "dynamicToolCall") {
    return {
      ...base,
      category: "工具",
      label: displayText([item.namespace, item.tool].filter(Boolean).join("/"), 180),
      detail: item.status === "inProgress" ? "正在执行工具" : item.success === false ? "工具执行失败" : "工具执行已结束"
    };
  }

  if (item.type === "fileChange") {
    const files = (item.changes ?? []).map((change) => relativeFilePath(cwd, change.path));
    return {
      ...base,
      category: "文件",
      label: `修改 ${files.length} 个文件`,
      detail: files.slice(0, 4).join("、") || "尚未返回文件列表"
    };
  }

  if (item.type === "webSearch") {
    return {
      ...base,
      category: "搜索",
      label: "网页搜索",
      detail: displayText(item.query, 420)
    };
  }

  if (item.type === "collabAgentToolCall") {
    return {
      ...base,
      category: "Agent",
      label: displayText(item.tool, 120),
      detail: `${item.receiverThreadIds?.length ?? 0} 个子 Agent`
    };
  }

  if (item.type === "subAgentActivity") {
    return {
      ...base,
      category: "Agent",
      label: displayText(item.kind, 120),
      detail: displayText(item.agentPath || item.agentThreadId, 240)
    };
  }

  if (item.type === "imageView") {
    return {
      ...base,
      category: "图片",
      label: "查看图片",
      detail: relativeFilePath(cwd, item.path)
    };
  }

  if (item.type === "contextCompaction") {
    return { ...base, category: "上下文", label: "压缩任务上下文", detail: "为后续工作释放上下文空间" };
  }

  return null;
}

function stageFromActivity(activity) {
  if (!activity) return null;
  if (activity.type === "mcpToolCall") return `正在调用 ${activity.label}`;
  if (activity.type === "commandExecution") return `正在执行：${activity.detail}`;
  if (activity.type === "dynamicToolCall") return `正在使用工具 ${activity.label}`;
  if (activity.type === "fileChange") return activity.label;
  if (activity.type === "collabAgentToolCall" || activity.type === "subAgentActivity") return `正在协调子 Agent：${activity.label}`;
  if (activity.type === "webSearch") return `正在搜索：${activity.detail}`;
  if (activity.type === "agentMessage") return activity.detail;
  return activity.label;
}

function parsePlanText(items) {
  const planItem = [...items].reverse().find((item) => item.type === "plan" && item.text?.trim());
  return planItem ? redactSensitive(planItem.text).trim().slice(0, 1_800) : "";
}

function extractDiffPaths(diff = "") {
  const result = [];
  for (const line of String(diff).split("\n")) {
    const match = line.match(/^\+\+\+\s+(?:b\/)?(.+)$/) ?? line.match(/^diff --git\s+a\/(.+?)\s+b\//);
    if (match && match[1] !== "/dev/null") result.push(match[1]);
  }
  return [...new Set(result)];
}

function turnKey(threadId, turnId) {
  return `${threadId}:${turnId ?? "latest"}`;
}

export class ProgressTracker {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.turns = new Map();
  }

  ingest(method, params = {}) {
    if (!params.threadId) return false;
    const turnId = params.turnId ?? params.turn?.id ?? null;
    if (!turnId) return false;
    const state = this.#state(params.threadId, turnId);
    const timestamp = this.now();
    state.updatedAt = timestamp;

    if (method === "turn/started") {
      state.status = params.turn?.status ?? "inProgress";
      state.startedAt = normalizedTimestamp(params.turn?.startedAt) ?? timestamp;
      for (const item of params.turn?.items ?? []) this.#upsertItem(state, item, timestamp);
    } else if (method === "turn/plan/updated") {
      state.plan = (params.plan ?? []).map((entry) => ({
        step: displayText(entry.step, 500),
        status: entry.status
      }));
      state.planExplanation = displayText(params.explanation, 600);
    } else if (method === "item/started" || method === "item/completed") {
      const fallbackStatus = method === "item/started" ? "inProgress" : "completed";
      this.#upsertItem(state, {
        ...params.item,
        status: params.item?.status ?? fallbackStatus
      }, timestamp);
    } else if (method === "item/agentMessage/delta") {
      const item = state.items.get(params.itemId) ?? { id: params.itemId, type: "agentMessage", phase: "commentary", text: "", status: "inProgress" };
      item.text = trimmedTail(`${item.text ?? ""}${params.delta ?? ""}`);
      item.updatedAt = timestamp;
      state.items.set(item.id, item);
      this.#touchOrder(state, item.id);
    } else if (method === "item/commandExecution/outputDelta") {
      const item = state.items.get(params.itemId) ?? { id: params.itemId, type: "commandExecution", command: "命令执行中", status: "inProgress" };
      item.aggregatedOutput = trimmedTail(`${item.aggregatedOutput ?? ""}${params.delta ?? ""}`, 1_200);
      item.updatedAt = timestamp;
      state.items.set(item.id, item);
      this.#touchOrder(state, item.id);
    } else if (method === "item/mcpToolCall/progress") {
      const item = state.items.get(params.itemId) ?? {
        id: params.itemId,
        type: "mcpToolCall",
        server: "MCP",
        tool: "工具调用",
        status: "inProgress"
      };
      item.progressMessage = trimmedTail(params.message, 800);
      item.updatedAt = timestamp;
      state.items.set(item.id, item);
      this.#touchOrder(state, item.id);
    } else if (method === "turn/diff/updated") {
      state.diffPaths = extractDiffPaths(params.diff);
    } else if (method === "turn/completed") {
      state.status = params.turn?.status ?? "completed";
      state.completedAt = normalizedTimestamp(params.turn?.completedAt) ?? timestamp;
      state.durationMs = params.turn?.durationMs ?? null;
      for (const item of params.turn?.items ?? []) this.#upsertItem(state, item, timestamp);
    } else {
      return false;
    }

    this.#prune();
    return true;
  }

  markAttention(threadId, turnId, message) {
    if (!threadId || !turnId) return;
    const state = this.#state(threadId, turnId);
    state.attention = displayText(message, 500);
    state.updatedAt = this.now();
  }

  snapshot(thread, { turnId = null, page = null, cursor = null } = {}) {
    const turns = thread.turns ?? [];
    const selectedTurn = turnId ? turns.find((turn) => turn.id === turnId) :
      turns.findLast((turn) => turn.status === "inProgress") ?? turns.at(-1) ?? null;
    const selectedTurnId = selectedTurn?.id ?? turnId ?? thread.rollout?.turnId ?? null;
    const live = selectedTurnId ? this.turns.get(turnKey(thread.id, selectedTurnId)) : null;
    const baseItems = selectedTurn?.items ?? [];
    const liveItems = live ? live.order.map((id) => live.items.get(id)).filter(Boolean) : [];
    const allItemsById = new Map();
    for (const item of [...baseItems, ...(page?.items ?? []), ...liveItems]) {
      if (item?.id) allItemsById.set(item.id, { ...(allItemsById.get(item.id) ?? {}), ...item });
    }
    const allItems = [...allItemsById.values()];

    const pageItems = page?.items?.length ? page.items : [...baseItems].reverse();
    const visibleItems = cursor ? pageItems : [
      ...[...liveItems].reverse(),
      ...pageItems.filter((item) => !live?.items.has(item.id))
    ];
    const activities = [];
    const seen = new Set();
    for (const item of visibleItems) {
      if (!item?.id || seen.has(item.id)) continue;
      seen.add(item.id);
      const activity = activityFromItem(allItemsById.get(item.id) ?? item, {
        cwd: thread.cwd,
        liveMeta: live?.items.get(item.id)
      });
      if (activity) activities.push(activity);
      if (activities.length >= 10) break;
    }

    const plan = live?.plan ?? [];
    const planCompleted = plan.filter((entry) => entry.status === "completed").length;
    const currentPlan = plan.find((entry) => entry.status === "inProgress");
    const runningActivity = activities.find((activity) => activity.status === "inProgress");
    const latestCommentary = activities.find((activity) => activity.type === "agentMessage" && activity.label !== "最终回复");
    const status = live?.status ?? selectedTurn?.status ?? thread.rollout?.status ?? (thread.status?.type === "active" ? "inProgress" : thread.status?.type);
    const startedAt = live?.startedAt ?? normalizedTimestamp(selectedTurn?.startedAt) ?? normalizedTimestamp(thread.rollout?.startedAt);
    const completedAt = live?.completedAt ?? normalizedTimestamp(selectedTurn?.completedAt) ?? normalizedTimestamp(thread.rollout?.completedAt);
    const durationMs = live?.durationMs ?? selectedTurn?.durationMs ?? (startedAt ? Math.max(0, (completedAt ?? this.now()) - startedAt) : null);

    const files = [];
    for (const item of allItems) {
      if (item.type !== "fileChange") continue;
      for (const change of item.changes ?? []) {
        files.push({
          path: relativeFilePath(thread.cwd, change.path),
          kind: fileChangeKind(change),
          status: item.status
        });
      }
    }
    for (const diffPath of live?.diffPaths ?? []) files.push({ path: relativeFilePath(thread.cwd, diffPath), kind: "update", status: "inProgress" });
    const uniqueFiles = [...new Map(files.map((file) => [file.path, file])).values()];

    const commands = allItems.filter((item) => item.type === "commandExecution");
    const tools = allItems.filter((item) => item.type === "mcpToolCall" || item.type === "dynamicToolCall");
    const errors = allItems.filter((item) => item.status === "failed" || item.error).length + (selectedTurn?.error ? 1 : 0);
    const currentStage = live?.attention ? live.attention :
      currentPlan?.step ? `正在执行：${currentPlan.step}` :
        stageFromActivity(runningActivity) ?? latestCommentary?.detail ?? thread.rollout?.progress ??
        (status === "completed" ? "任务已完成" : status === "failed" ? "任务执行失败" : "Codex 正在处理此任务");

    return {
      threadId: thread.id,
      turnId: selectedTurnId,
      status,
      statusLabel: statusLabel(status),
      startedAt,
      completedAt,
      durationMs,
      updatedAt: live?.updatedAt ?? normalizedTimestamp(thread.updatedAt ?? thread.updated_at ?? thread.rollout?.mtimeMs),
      currentStage: displayText(currentStage, 700),
      attention: live?.attention ?? null,
      plan,
      planText: plan.length ? "" : parsePlanText(allItems),
      planExplanation: live?.planExplanation ?? "",
      planCompleted,
      planTotal: plan.length,
      activities,
      files: uniqueFiles.slice(0, 20),
      stats: {
        tools: tools.length,
        commands: commands.length,
        files: uniqueFiles.length,
        errors
      },
      page: {
        cursor,
        nextCursor: page?.nextCursor ?? null,
        isHistorical: Boolean(cursor)
      },
      error: selectedTurn?.error?.message ? displayText(selectedTurn.error.message, 600) : null
    };
  }

  #state(threadId, turnId) {
    const key = turnKey(threadId, turnId);
    let state = this.turns.get(key);
    if (!state) {
      state = {
        threadId,
        turnId,
        status: "inProgress",
        startedAt: null,
        completedAt: null,
        durationMs: null,
        updatedAt: this.now(),
        plan: [],
        planExplanation: "",
        attention: null,
        items: new Map(),
        order: [],
        diffPaths: []
      };
      this.turns.set(key, state);
    }
    return state;
  }

  #upsertItem(state, item, timestamp) {
    if (!item?.id) return;
    state.items.set(item.id, { ...(state.items.get(item.id) ?? {}), ...item, updatedAt: timestamp });
    this.#touchOrder(state, item.id);
    while (state.order.length > MAX_TRACKED_ITEMS) {
      const removed = state.order.shift();
      state.items.delete(removed);
    }
  }

  #touchOrder(state, itemId) {
    state.order = [...state.order.filter((id) => id !== itemId), itemId];
  }

  #prune() {
    while (this.turns.size > MAX_TRACKED_TURNS) this.turns.delete(this.turns.keys().next().value);
  }
}
