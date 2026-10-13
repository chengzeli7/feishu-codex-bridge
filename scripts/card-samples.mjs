import * as cards from '../src/cards.mjs';
import { VERSION } from '../src/version.mjs';

export function cardSamples({ workspaces = { 'no-project': '/tmp/FeishuTasks', app: '/tmp/app' }, defaultWorkspace = 'no-project' } = {}) {
  const thread = { id: '019f0000-0000-7000-8000-000000000001', name: '整理会议记录',
    cwd: Object.values(workspaces)[0], status: { type: 'active' }, updatedAt: Date.now(),
    turns: [{ id: 'turn-sample', status: 'inProgress', items: [{ id: 'reply', type: 'agentMessage', text: '正在整理决定和待办。' }] }] };
  const completed = { ...thread, status: { type: 'idle' }, turns: [{ id: 'turn-sample', status: 'completed', items: [{ type: 'agentMessage', phase: 'final_answer', text: '已整理三项决定和两条待办，请核对负责人。' }] }] };
  const detail = { turnId: 'turn-sample', status: 'inProgress', statusLabel: '运行中', durationMs: 75000,
    updatedAt: Date.now(), currentStage: '正在核对待办负责人',
    plan: [{ step: '整理主要决定', status: 'completed' }, { step: '核对待办与负责人', status: 'inProgress' }],
    planTotal: 2, planCompleted: 1, activities: [{ id: 'tool', type: 'mcpToolCall', category: '工具', label: '读取文档', detail: '正在执行', status: 'inProgress', statusLabel: '运行中' }],
    files: [], stats: { tools: 1, commands: 0, files: 0, errors: 0 }, page: { nextCursor: 'older', isHistorical: false } };
  const health = { version: VERSION, uptime: '1小时', codexReady: true, larkReady: true, larkConnectionState: 'connected', queuedCount: 0, watchCount: 1, lastMessageAt: Date.now(), lastReplyAt: Date.now() };
  const queued = { id: 'queued', threadId: thread.id, text: '再把待办按负责人分组。' };
  const titles = new Map([[thread.id, thread.name]]);
  const schedule = { id: 'schedule', prompt: '整理今天的待办', workspace: defaultWorkspace, label: '每天 09:00', status: 'active', nextRunAt: Date.now() + 60000 };
  return new Map([
    ['home', cards.taskListCard([thread, { ...completed, id: 'done' }], { focusedThreadId: thread.id, health })],
    ['home-empty', cards.taskListCard([], { health })],
    ['create-form', cards.createTaskFormCard(workspaces, defaultWorkspace)],
    ['progress', cards.progressCard(thread, { watching: true })],
    ['progress-completed', cards.progressCard(completed)],
    ['progress-detail', cards.progressDetailCard(thread, detail)],
    ['progress-history', cards.progressDetailCard(thread, { ...detail, page: { nextCursor: 'older-again', isHistorical: true } })],
    ['send-form', cards.sendMessageFormCard(thread)],
    ['completion', cards.completionCard(completed, 'completed')],
    ['completion-failed', cards.completionCard(thread, 'failed', '材料暂时无法访问，请检查文档权限。')],
    ['stop-confirm', cards.stopConfirmCard(thread)],
    ['health', cards.healthCard(health)],
    ['health-unverified', cards.healthCard({ ...health, larkReady: false, larkConnectionState: 'unverified', lastMessageAt: null })],
    ['queue', cards.queueCard([queued], titles)],
    ['queue-paused', cards.queueCard([{ ...queued, dispatchPaused: true, lastError: 'Connection failed' }], titles)],
    ['queue-uncertain', cards.queueCard([{ ...queued, dispatchPaused: true, submissionUncertain: true, lastError: 'Request timed out' }], titles)],
    ['notice', cards.noticeCard({ title: '补充已保存', message: '当前事项结束后发送，无需重复提交。', action: { text: '查看待发送', action: 'queue' } })],
    ['clarification', cards.clarificationCard({ id: 'pending', message: '帮我整理成三个要点。' }, thread, defaultWorkspace)],
    ['schedule-list', cards.scheduleListCard([schedule])],
    ['schedule-empty', cards.scheduleListCard([])],
    ['schedule-form', cards.scheduleCreateFormCard(defaultWorkspace)],
    ['schedule-detail', cards.scheduleDetailCard(schedule)],
    ['schedule-paused', cards.scheduleDetailCard({ ...schedule, status: 'paused' })],
    ['schedule-completed', cards.scheduleDetailCard({ ...schedule, status: 'completed' })],
    ['help', cards.helpCard()]
  ]);
}
