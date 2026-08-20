import path from "node:path";
import { normalizeMessage } from "./commands.mjs";

const SMALL_TALK = /^(你好|您好|嗨|哈喽|hello|hi|在吗|谢谢|多谢|辛苦了|收到|好的|好)$/i;
const LIST_INTENT = /^(看看|查看|列出|显示)?\s*(最近|现在|当前)?\s*(有(哪些|什么))?\s*(Codex\s*)?(任务|任务列表)$/i;
const PROGRESS_INTENT = /^(当前|现在|刚才|这个)?\s*(任务)?\s*(进度|状态|怎么样|完成了吗|好了吗)[？?。!！]*$/i;
const CONTINUATION_PREFIX = /^(继续|接着|再|然后|另外|补充|顺便|还有|以及|同时|刚才|这个任务|上一个任务|把|改成|改为|加上|不要|需要)/i;
const AMBIGUOUS_SHORT = /^(这个|那个|然后呢|这个呢|怎么看|再看看|处理一下|继续吧|怎么办|可以吗|行吗)[？?。!！]*$/i;
const NATURAL_SCHEDULE = /^(?:每天\s*\d{1,2}(?::|点)|每周[一二三四五六日天]\s*\d{1,2}(?::|点)|(?:明天|后天)\s*\d{1,2}(?::|点)|\d+\s*(?:分钟|小时)后|\d{4}-\d{1,2}-\d{1,2}\s+\d{1,2}(?::|点))/;

function normalizedTerms(alias, workspacePath, configured = []) {
  const basename = path.basename(workspacePath);
  return [...new Set([
    alias,
    alias.replaceAll("-", " "),
    basename,
    ...configured
  ].map((term) => String(term).trim()).filter(Boolean))];
}

export function workspaceCatalog(workspaces, aliases = {}) {
  return Object.entries(workspaces).map(([alias, workspacePath]) => ({
    alias,
    path: workspacePath,
    terms: normalizedTerms(alias, workspacePath, aliases[alias] ?? [])
  }));
}

export function detectWorkspace(text, workspaces, aliases = {}, defaultWorkspace = null) {
  const normalized = text.toLocaleLowerCase("zh-CN");
  const matches = workspaceCatalog(workspaces, aliases)
    .map((workspace) => ({
      ...workspace,
      score: Math.max(0, ...workspace.terms.map((term) => {
        const candidate = term.toLocaleLowerCase("zh-CN");
        return normalized.includes(candidate) ? candidate.length : 0;
      }))
    }))
    .filter((workspace) => workspace.score > 0)
    .sort((left, right) => right.score - left.score);
  return matches[0]?.alias ?? defaultWorkspace ?? Object.keys(workspaces)[0] ?? null;
}

export function routeNaturalMessage({
  content,
  chatState = {},
  boundThreadId = null,
  workspaces,
  workspaceAliases = {},
  defaultWorkspace = null,
  hasAttachments = false
}) {
  const text = normalizeMessage(content ?? "");
  const focusedThreadId = boundThreadId ?? chatState.focusedThreadId ?? chatState.selectedThreadId ?? null;

  if (!hasAttachments && SMALL_TALK.test(text)) {
    return { type: "small_talk", message: text };
  }
  if (!hasAttachments && LIST_INTENT.test(text)) {
    return { type: "list", filter: null };
  }
  if (!hasAttachments && PROGRESS_INTENT.test(text) && focusedThreadId) {
    return { type: "progress", selector: focusedThreadId };
  }
  if (!hasAttachments && NATURAL_SCHEDULE.test(text)) {
    return { type: "schedule_create", expression: text };
  }

  const message = text || (hasAttachments ? "请处理我刚刚发送的附件。" : "");
  if (boundThreadId) {
    return { type: "send", selector: boundThreadId, message, routeReason: "reply_binding" };
  }
  if (focusedThreadId && AMBIGUOUS_SHORT.test(text)) {
    return {
      type: "clarify",
      message,
      threadId: focusedThreadId,
      workspace: detectWorkspace(text, workspaces, workspaceAliases, defaultWorkspace)
    };
  }
  if (focusedThreadId && CONTINUATION_PREFIX.test(text)) {
    return { type: "send", selector: focusedThreadId, message, routeReason: "focused_continuation" };
  }

  return {
    type: "create",
    workspace: detectWorkspace(text, workspaces, workspaceAliases, defaultWorkspace),
    message,
    routeReason: hasAttachments ? "attachment_task" : "new_task"
  };
}
