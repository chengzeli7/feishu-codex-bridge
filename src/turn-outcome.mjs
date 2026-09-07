export const TERMINAL_STATUSES = new Set(["completed", "failed", "interrupted"]);

export function finalAnswer(turn) {
  const messages = (turn?.items ?? []).filter((item) => item.type === "agentMessage" && item.text?.trim());
  return messages.findLast((item) => item.phase === "final_answer")?.text.trim()
    ?? messages.findLast((item) => !item.phase)?.text.trim() ?? "";
}

export function confirmedOutcome(turn, { authoritative = false, rollout = null } = {}) {
  if (!turn?.id) return null;
  if (authoritative && TERMINAL_STATUSES.has(turn.status)) {
    return { turnId: turn.id, status: turn.status, answer: finalAnswer(turn), observedAt: Date.now() };
  }
  if (rollout?.turnId === turn.id && TERMINAL_STATUSES.has(rollout.status)) {
    return { turnId: turn.id, status: rollout.status, answer: rollout.result || finalAnswer(turn), observedAt: Date.now() };
  }
  if (TERMINAL_STATUSES.has(turn.status) && turn.completedAt != null) {
    return { turnId: turn.id, status: turn.status, answer: finalAnswer(turn), observedAt: Date.now() };
  }
  return null;
}

export function outcomeText(outcome) {
  if (outcome.answer) return outcome.answer;
  return outcome.status === "completed" ? "本轮已结束，但未提供最终文字答复。" :
    outcome.status === "interrupted" ? "本轮已停止；你可以发送新消息继续此任务。" :
      "本轮执行失败，未提供最终文字答复；你可以查看详细进展后继续。";
}
