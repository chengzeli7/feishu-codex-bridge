import { latestAgentMessage, latestCommand, latestTurn } from "./codex-client.mjs";
import { statusLabel, threadTitle, truncate } from "./commands.mjs";

function statusDisplay(status) {
  if (status.includes("进行中")) return `🟢 ${status}`;
  if (status.includes("已完成")) return `✅ ${status}`;
  if (status.includes("失败") || status.includes("错误")) return `🔴 ${status}`;
  if (status.includes("中断")) return `⏸️ ${status}`;
  return `⚪ ${status}`;
}

export function formatThreadList(threads) {
  if (threads.length === 0) return "### 最近 Codex 任务\n\n暂时没有找到任务。";
  const rows = threads.map((thread, index) => {
    const cwd = thread.cwd ? `\n📁 \`${thread.cwd}\`` : "";
    const status = thread.rollout?.status === "inProgress" ? "进行中（Desktop）" :
      thread.rollout?.status === "completed" ? "已完成" : statusLabel(thread.status);
    return `**${index + 1}　${statusDisplay(status)}**\n${truncate(threadTitle(thread), 90)}${cwd}\nID　\`${thread.id}\``;
  });
  return `### 最近 Codex 任务\n\n${rows.join("\n\n---\n\n")}\n\n> 查看详情：\`进度1\`　继续任务：\`继续1 你的消息\``;
}

export function formatProgress(thread) {
  const turn = latestTurn(thread);
  const agentMessage = thread.rollout?.progress || thread.rollout?.result || latestAgentMessage(thread);
  const command = latestCommand(thread);
  const effectiveStatus = thread.rollout?.status === "inProgress" ? "进行中（Desktop）" :
    thread.rollout?.status === "completed" ? "已完成" : statusLabel(thread.status);
  const parts = [
    `### ${threadTitle(thread)}`,
    `${statusDisplay(effectiveStatus)}${thread.rollout ? `　回合 \`${thread.rollout.turnId}\`` : turn ? `　本轮 ${statusLabel(turn.status)}` : ""}`,
    `📁 \`${thread.cwd}\`\n\nID　\`${thread.id}\``
  ];
  if (agentMessage) parts.push(`**最近进展**\n\n${truncate(agentMessage)}`);
  if (!agentMessage && command) {
    parts.push(`**最近命令**\n\n\`${truncate(command.command, 300)}\`\n\n状态：${statusLabel(command.status)}`);
  }
  if (turn?.error) parts.push(`**错误**\n\n${truncate(turn.error.message ?? JSON.stringify(turn.error), 500)}`);
  if (thread.status?.type === "notLoaded" && thread.rollout?.status === "inProgress") {
    parts.push("> 实时进度来自 Codex Desktop 正在写入的本地 rollout；当前桥接只读监控，不会并发控制该回合。");
  } else if (thread.status?.type === "notLoaded") {
    parts.push("> 该任务未载入当前桥接进程。这里展示已落盘进度，无法确认另一个 Codex Desktop 进程中的实时运行状态。");
  }
  return parts.join("\n\n");
}

export function formatCompletion(thread, turnStatus, resultOverride = "") {
  const result = resultOverride || thread.rollout?.result || latestAgentMessage(thread);
  const title = threadTitle(thread);
  const heading = turnStatus === "completed" ? "✅ Codex 任务已完成" : `Codex 任务${statusLabel(turnStatus)}`;
  return `### ${heading}\n\n**${title}**${result ? `\n\n**结果**\n\n${truncate(result, 1800)}` : ""}\n\nID　\`${thread.id}\``;
}

export const HELP_TEXT = `### Codex 飞书助手

- \`任务\` / \`进行中\` / \`已完成\`　查看任务
- \`新建\`　打开创建表单
- \`搜索 关键词\`　搜索任务
- \`进度1\`　查看进度并关注完成通知
- \`继续1 你的消息\`　发送后续指令
- \`停止1\` / \`关注1\` / \`取消关注1\`　控制任务
- \`重命名1 新名称\` / \`归档1\`　管理任务
- \`队列\` / \`静默 2小时\` / \`健康\`　管理助手

> 序号和命令之间可不加空格。未写序号时，使用当前会话最近选择的任务。只接受已配置用户的私聊，不处理高风险审批。`;
