const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i;
const SELECTOR_PATTERN = "(?:\\d+|[0-9a-f]{8}-[0-9a-f-]{27,})";

export function normalizeMessage(content) {
  return content
    .replace(/^\s*@?Codex[：:，,\s]*/i, "")
    .replace(/^\s*@?科德克斯[：:，,\s]*/i, "")
    .trim();
}

export function parseCommand(content) {
  const text = normalizeMessage(content);
  if (!text || /^(帮助|help|\?)$/i.test(text)) return { type: "help" };
  if (/^(任务|首页|最近任务|任务列表|list)$/i.test(text)) return { type: "list", filter: null };
  if (/^(进行中|运行中)$/i.test(text)) return { type: "list", filter: "active" };
  if (/^(已完成|完成任务)$/i.test(text)) return { type: "list", filter: "completed" };
  if (/^(当前任务|当前|本任务)$/i.test(text)) return { type: "progress", selector: null };
  if (/^(健康|状态检查|health)$/i.test(text)) return { type: "health" };
  if (/^(版本|version)$/i.test(text)) return { type: "version" };
  if (/^(通知|通知设置)$/i.test(text)) return { type: "notification_status" };
  if (/^(取消静默|恢复通知)$/i.test(text)) return { type: "unmute" };
  if (/^队列$/i.test(text)) return { type: "queue_list" };
  if (/^(定时任务|计划任务|定时列表)$/i.test(text)) return { type: "schedule_list" };

  const scheduleControl = text.match(/^(暂停定时|恢复定时|取消定时)\s*(\d+|[0-9a-f]{8}-[0-9a-f-]{27,})$/i);
  if (scheduleControl) {
    return {
      type: {
        暂停定时: "schedule_pause",
        恢复定时: "schedule_resume",
        取消定时: "schedule_cancel"
      }[scheduleControl[1]],
      selector: scheduleControl[2]
    };
  }

  const schedule = text.match(/^(?:定时|计划)\s+([\s\S]+)$/i);
  if (schedule) return { type: "schedule_create", expression: schedule[1].trim() };

  const mute = text.match(/^静默\s*(\d+)\s*(分钟|小时|天)$/i);
  if (mute) {
    const multiplier = mute[2] === "分钟" ? 60_000 : mute[2] === "小时" ? 3_600_000 : 86_400_000;
    return { type: "mute", durationMs: Number(mute[1]) * multiplier };
  }

  const search = text.match(/^搜索\s+(.+)$/i);
  if (search) return { type: "search", query: search[1].trim() };

  const create = text.match(/^新建(?:任务)?(?:\s+([^\s]+)(?:\s+([\s\S]+))?)?$/i);
  if (create) {
    if (!create[1]) return { type: "create_form" };
    return { type: "create", workspace: create[1].trim(), message: create[2]?.trim() ?? "" };
  }

  const progress = text.match(/^(?:进度|状态|status)\s*(.*)$/i);
  if (progress) {
    const selector = progress[1].trim();
    if (!selector || /^\d+$/.test(selector) || UUID_PATTERN.test(selector)) {
      return { type: "progress", selector: selector || null };
    }
  }

  const progressDetail = text.match(/^(?:查看)?(?:详情|详细进展|执行详情)\s*(.*)$/i);
  if (progressDetail) {
    const selector = progressDetail[1].trim();
    if (!selector || /^\d+$/.test(selector) || UUID_PATTERN.test(selector)) {
      return { type: "progress_detail", selector: selector || null };
    }
  }

  if (/^重命名(?:\s|\d|$)/i.test(text)) return { type: "removed_rename" };

  const simpleSelectorCommands = [
    ["取消关注", "unwatch"],
    ["关注", "watch"],
    ["停止", "stop"],
    ["归档", "archive"],
    ["恢复归档", "unarchive"],
    ["取消队列", "queue_cancel"]
  ];
  for (const [keyword, type] of simpleSelectorCommands) {
    const match = text.match(new RegExp(`^${keyword}\\s*(${SELECTOR_PATTERN})?$`, "i"));
    if (match) return { type, selector: match[1]?.trim() || null };
  }

  const send = text.match(/^(?:继续|发送|告诉|send)\s*(.+)$/i);
  if (send) {
    const rest = send[1].trim();
    const [first, ...remaining] = rest.split(/\s+/);
    const hasSelector = /^\d+$/.test(first) || UUID_PATTERN.test(first);
    return {
      type: "send",
      selector: hasSelector ? first : null,
      message: hasSelector ? remaining.join(" ").trim() : rest
    };
  }

  return { type: "unknown", raw: text };
}

export function isThreadSelector(value) {
  return /^\d+$/.test(value ?? "") || UUID_PATTERN.test(value ?? "");
}

export function resolveThreadId(selector, chatState, availableThreads = []) {
  if (selector && UUID_PATTERN.test(selector)) return selector;
  if (selector && /^\d+$/.test(selector)) {
    const index = Number(selector) - 1;
    return chatState.recentThreadIds?.[index] ?? null;
  }
  return chatState.focusedThreadId ?? chatState.selectedThreadId ?? availableThreads[0]?.id ?? null;
}

export function statusLabel(status) {
  const type = typeof status === "string" ? status : status?.type;
  return {
    active: "进行中",
    idle: "空闲/已结束",
    notLoaded: "未载入",
    systemError: "系统错误",
    completed: "已完成",
    interrupted: "已中断",
    failed: "失败",
    inProgress: "进行中"
  }[type] ?? type ?? "未知";
}

export function threadTitle(thread) {
  return (thread.name || thread.preview || "未命名任务").replace(/\s+/g, " ").trim();
}

export function truncate(text, max = 1200) {
  if (!text) return "";
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
