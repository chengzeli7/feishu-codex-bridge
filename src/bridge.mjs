import path from "node:path";
import { loadConfig } from "./config.mjs";
import { CodexClient, latestTurn } from "./codex-client.mjs";
import { LarkClient } from "./lark-client.mjs";
import { parseCommand, resolveThreadId, threadTitle, truncate } from "./commands.mjs";
import { detectWorkspace, routeNaturalMessage } from "./intent-router.mjs";
import { AttachmentManager, eventHasResources } from "./attachment-manager.mjs";
import { nextScheduleRun, parseScheduleExpression, scheduleLabel } from "./scheduler.mjs";
import { StateStore } from "./state-store.mjs";
import { readRolloutSnapshot } from "./rollout-monitor.mjs";
import { ProgressTracker } from "./progress-tracker.mjs";
import {
  completionCard,
  clarificationCard,
  createTaskFormCard,
  healthCard,
  helpCard,
  noticeCard,
  parseActionValue,
  progressCard,
  progressDetailCard,
  queueCard,
  scheduleDetailCard,
  scheduleListCard,
  sendMessageFormCard,
  stopConfirmCard,
  taskListCard
} from "./cards.mjs";
import { Logger } from "./logger.mjs";
import { InstanceLock } from "./instance-lock.mjs";
import { DesktopSync } from "./desktop-sync.mjs";
import { CodexDaemonManager } from "./codex-daemon.mjs";
import { enableDesktopDaemonEnvironment } from "./desktop-daemon-env.mjs";

const VERSION = "0.1.0";
const EVENT_KEYS = ["im.message.receive_v1", "card.action.trigger"];
const DETAIL_ITEM_PAGE_SIZE = 24;
const MUTATING_ACTIONS = new Set([
  "create", "send", "stop", "archive", "queue_cancel",
  "clarify_continue", "clarify_create", "clarify_cancel",
  "schedule_pause", "schedule_resume", "schedule_cancel"
]);
const SUPPORTED_MESSAGE_TYPES = new Set(["text", "post", "image", "file", "audio", "media", "video"]);

function card(content, metadata = {}) {
  return { type: "card", content, ...metadata };
}

function markdown(content, metadata = {}) {
  return { type: "markdown", content, ...metadata };
}

function durationLabel(milliseconds) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (days) return `${days}天${hours}小时`;
  if (hours) return `${hours}小时${minutes}分钟`;
  return `${minutes}分钟`;
}

function currentTurnId(thread) {
  return thread.turns?.findLast((turn) => turn.status === "inProgress")?.id ??
    thread.rollout?.turnId ?? latestTurn(thread)?.id ?? null;
}

function isActive(thread) {
  return thread.status?.type === "active" || latestTurn(thread)?.status === "inProgress" || thread.rollout?.status === "inProgress";
}

function isDesktopActive(thread) {
  return thread.status?.type !== "active" && thread.rollout?.status === "inProgress";
}

function mediaFallback(event) {
  const label = {
    image: "图片",
    file: "文件",
    audio: "语音",
    media: "媒体文件",
    video: "视频"
  }[event.message_type] ?? "附件";
  return `请读取并分析我发送的${label}，结合当前项目完成其中明确要求；如果没有明确要求，请先给出内容摘要和一个最必要的下一步建议。`;
}

function normalizedEventContent(event, transcript, hasAttachments) {
  if (transcript) return transcript.trim();
  const content = String(event.content ?? "").trim();
  if (!hasAttachments) return content;
  if (!content || /^(?:!\[[^\]]*\]\([^)]+\)|<(?:file|audio|media)\b[^>]*>|\[(?:图片|文件|语音|视频)\])$/i.test(content)) {
    return mediaFallback(event);
  }
  return content;
}

export class Bridge {
  constructor({ config, codex, codexDaemon, lark, state, logger, lock, desktopSync, attachments, progressTracker }) {
    this.config = config;
    this.codex = codex ?? new CodexClient({ bin: config.codexBin, socketPath: config.codexAppServerSocket });
    this.codexDaemon = codexDaemon === undefined ? new CodexDaemonManager({
      bin: config.codexBin,
      enabled: config.desktopSyncEnabled === true && Boolean(config.codexAppServerSocket)
    }) : codexDaemon;
    this.lark = lark ?? new LarkClient({ bin: config.larkBin, spoolRoot: config.eventSpoolDir });
    this.state = state ?? new StateStore(config.stateFile);
    this.logger = logger ?? new Logger(config.logFile);
    this.lock = lock ?? new InstanceLock(config.lockFile);
    this.desktopSync = desktopSync ?? new DesktopSync({ enabled: config.desktopAutoOpenEnabled === true });
    this.attachments = attachments ?? new AttachmentManager({
      root: config.attachmentsDir ?? path.join(path.dirname(config.stateFile), "attachments"),
      maxBytes: config.maxAttachmentBytes,
      retentionDays: config.attachmentRetentionDays,
      ffmpegBin: config.ffmpegBin
    });
    this.progressTracker = progressTracker ?? new ProgressTracker();
    this.pollTimer = null;
    this.shuttingDown = false;
    this.startedAt = Date.now();
    this.lastMessageAt = null;
    this.lastReplyAt = null;
    this.readyEventKeys = new Set();
    this.reconnectTimers = new Map();
    this.larkReconnectAttempts = new Map();
    this.codexReconnectTimer = null;
    this.codexReconnectAttempt = 0;
    this.codexStarting = false;
    this.operationDispatching = false;
    this.schedulePolling = false;
    this.lastAttachmentCleanupAt = 0;
    this.activeTasks = new Set();
    this.detailSubscriptions = new Map();
    this.detailUpdateTimers = new Map();
    this.detailItemsApiSupported = true;
  }

  async start() {
    await this.lock.acquire();
    try {
      await this.logger.init();
      await this.state.load();
      this.state.prunePendingIntents();
      await this.attachments.init({ protectedPaths: this.#protectedAttachmentPaths() });
      this.#bindEvents();
      await this.#startCodex();
      for (const eventKey of EVENT_KEYS) this.#startLarkConsumer(eventKey);
      this.pollTimer = setInterval(() => this.#track(
        this.#poll().catch((error) => this.#logError("background poll failed", error))
      ), this.config.pollIntervalMs);
      await this.#poll();
      this.logger.info("Codex Feishu bridge started", { version: VERSION, allowedUserCount: this.config.allowedUserIds.length });
    } catch (error) {
      await this.lock.release();
      throw error;
    }
  }

  async stop() {
    this.shuttingDown = true;
    clearInterval(this.pollTimer);
    clearTimeout(this.codexReconnectTimer);
    for (const timer of this.detailUpdateTimers.values()) clearTimeout(timer);
    this.detailUpdateTimers.clear();
    this.detailSubscriptions.clear();
    for (const timer of this.reconnectTimers.values()) clearTimeout(timer);
    this.reconnectTimers.clear();
    await Promise.allSettled([this.lark.stop(), this.codex.stop()]);
    while (this.activeTasks.size > 0) {
      await Promise.allSettled([...this.activeTasks]);
    }
    await this.state.flush();
    await this.lock.release();
    this.logger.info("Codex Feishu bridge stopped");
  }

  async executeCommand(command, event, { fromAction = false, confirmed = false, attachments = [] } = {}) {
    if (command.type === "help") return card(helpCard());
    if (command.type === "unknown") {
      command = {
        type: "create",
        workspace: this.config.defaultWorkspace ?? Object.keys(this.config.workspaces)[0],
        message: command.raw
      };
    }
    if (command.type === "unsupported_message") {
      return card(noticeCard({
        title: "暂不支持这种消息",
        message: "2.1 支持文字、富文本、图片、文件、语音和视频文件。请换一种方式发送。",
        template: "yellow",
        status: "未处理"
      }));
    }
    if (command.type === "removed_rename") {
      return card(noticeCard({
        title: "任务重命名已移除",
        message: "2.1 不再提供飞书端重命名。需要修改名称时请在 Codex Desktop 中操作。",
        template: "grey",
        status: "功能已移除",
        action: { text: "任务首页", action: "home" }
      }));
    }
    if (command.type === "small_talk") {
      return card(noticeCard({
        title: "我在",
        message: "直接告诉我要做什么，或发送图片、文件、语音。我会自动判断是新建任务还是继续当前任务。",
        template: "blue",
        status: "就绪",
        action: { text: "任务首页", action: "home" }
      }));
    }
    if (command.type === "health") return card(healthCard(this.#health()));
    if (command.type === "version") {
      return card(noticeCard({ title: "Codex 飞书助手", message: `正式版 v${VERSION}\n详细进展 · 自然语言会话 · 多模态附件 · 定时任务 · 离线恢复`, status: "版本" }));
    }
    if (command.type === "notification_status") {
      const mutedUntil = this.state.mutedUntil();
      const message = this.state.isMuted() ? `完成通知已静默至 ${new Date(mutedUntil).toLocaleString("zh-CN")}` : "完成通知当前正常开启。";
      return card(noticeCard({ title: "通知设置", message, template: this.state.isMuted() ? "yellow" : "green", status: this.state.isMuted() ? "静默中" : "已开启" }));
    }
    if (command.type === "mute") {
      const until = Date.now() + command.durationMs;
      this.state.setMutedUntil(until);
      await this.state.save();
      return card(noticeCard({ title: "已静默完成通知", message: `静默至 ${new Date(until).toLocaleString("zh-CN")}。排队消息仍会自动发送。`, template: "yellow", status: "静默中" }));
    }
    if (command.type === "unmute") {
      this.state.setMutedUntil(null);
      await this.state.save();
      return card(noticeCard({ title: "已恢复通知", message: "后续关注任务完成时会继续在飞书提醒。", template: "green", status: "已开启" }));
    }
    if (command.type === "queue_list") return card(await this.#queueCard());
    if (command.type === "create_form") return card(createTaskFormCard(this.config.workspaces, this.config.defaultWorkspace));

    if (command.type === "schedule_create") {
      const parsed = parseScheduleExpression(command.expression, {
        timeZone: this.config.timeZone ?? "Asia/Shanghai",
        defaultWorkspace: this.config.defaultWorkspace,
        detectWorkspace: (text) => detectWorkspace(
          text,
          this.config.workspaces,
          this.config.workspaceAliases,
          this.config.defaultWorkspace
        )
      });
      const schedule = this.state.addSchedule({
        ...parsed,
        chatId: event.chat_id,
        sourceMessageId: event.message_id,
        senderId: event.sender_id ?? event.operator_id
      });
      schedule.label = scheduleLabel(schedule);
      this.state.setRecentSchedules(event.chat_id, [
        schedule.id,
        ...(this.state.getChat(event.chat_id).recentScheduleIds ?? []).filter((id) => id !== schedule.id)
      ].slice(0, 20));
      await this.state.save();
      return card(scheduleDetailCard(schedule), { scheduleId: schedule.id });
    }

    if (command.type === "schedule_list") {
      const schedules = this.state.schedulesForChat(event.chat_id);
      this.state.setRecentSchedules(event.chat_id, schedules.map((schedule) => schedule.id));
      await this.state.save();
      return card(scheduleListCard(schedules));
    }

    if (command.type === "schedule_detail" || command.type === "schedule_pause" ||
        command.type === "schedule_resume" || command.type === "schedule_cancel") {
      const schedule = this.#resolveSchedule(command.scheduleId ?? command.selector, event.chat_id);
      if (command.type === "schedule_pause") {
        if (schedule.status !== "active") throw new Error("只有已启用的定时任务可以暂停");
        this.state.updateSchedule(schedule.id, { status: "paused" });
        this.state.cancelScheduleOperations(schedule.id);
      }
      if (command.type === "schedule_resume") {
        if (schedule.status !== "paused") throw new Error("只有已暂停的定时任务可以恢复");
        this.state.updateSchedule(schedule.id, {
          status: "active",
          nextRunAt: nextScheduleRun(schedule.spec, new Date(), schedule.timeZone)
        });
      }
      if (command.type === "schedule_cancel") {
        this.state.updateSchedule(schedule.id, { status: "canceled" });
        this.state.cancelScheduleOperations(schedule.id);
      }
      const updated = this.state.getSchedule(schedule.id);
      await this.state.save();
      return card(scheduleDetailCard(updated), { scheduleId: updated.id });
    }

    if (command.type === "clarify") {
      const pending = this.state.createPendingIntent({
        chatId: event.chat_id,
        sourceMessageId: event.message_id,
        senderId: event.sender_id ?? event.operator_id,
        message: command.message,
        threadId: command.threadId,
        workspace: command.workspace,
        attachments
      });
      let currentThread = { id: command.threadId, name: `任务 ${command.threadId.slice(0, 8)}` };
      if (this.codex.ready) {
        try { currentThread = await this.codex.readThread(command.threadId); } catch { /* keep the stable fallback */ }
      }
      await this.state.save();
      return card(clarificationCard(pending, currentThread, command.workspace));
    }

    if (command.type === "resolve_intent") {
      const pending = this.state.getPendingIntent(command.pendingId);
      if (!pending || pending.chatId !== event.chat_id) throw new Error("这条待确认消息已过期，请重新发送");
      this.state.consumePendingIntent(command.pendingId);
      await this.state.save();
      if (command.resolution === "cancel") {
        return card(noticeCard({ title: "已取消", message: "原消息没有发送给 Codex。", template: "grey", status: "已取消", action: { text: "任务首页", action: "home" } }));
      }
      const resolved = command.resolution === "continue" ?
        { type: "send", selector: pending.threadId, message: pending.message } :
        { type: "create", workspace: pending.workspace, message: pending.message };
      return this.executeCommand(resolved, event, { fromAction, confirmed, attachments: pending.attachments ?? [] });
    }

    if (command.type === "list") {
      this.#requireCodex();
      const threads = await this.#recentThreads();
      this.state.setRecentThreads(event.chat_id, threads.map((thread) => thread.id));
      await this.state.save();
      return card(taskListCard(threads, {
        queuedCount: this.state.allQueued().length + this.state.allOperations().length,
        filter: command.filter ?? null,
        focusedThreadId: this.state.getChat(event.chat_id).focusedThreadId
      }));
    }

    if (command.type === "search") {
      this.#requireCodex();
      if (!command.query || command.query.length > 100) throw new Error("搜索关键词长度需要在 1–100 个字符之间");
      const threads = await Promise.all((await this.codex.searchThreads(command.query, 10)).map((thread) => this.#enrichThread(thread)));
      this.state.setRecentThreads(event.chat_id, threads.map((thread) => thread.id));
      await this.state.save();
      return card(taskListCard(threads, {
        queuedCount: this.state.allQueued().length + this.state.allOperations().length,
        focusedThreadId: this.state.getChat(event.chat_id).focusedThreadId
      }));
    }

    if (command.type === "create") {
      this.#validateCreate(command);
      if (!this.codex.ready) {
        const operation = this.state.enqueueOperation({
          type: "create",
          workspace: command.workspace,
          text: command.message,
          effort: command.effort ?? "default",
          attachments,
          chatId: event.chat_id,
          sourceMessageId: event.message_id,
          senderId: event.sender_id ?? event.operator_id
        }, this.config.maxOfflineOperations ?? 50);
        await this.state.save();
        return card(noticeCard({
          title: "任务已进入离线队列",
          message: `Codex 正在重连，恢复后会自动创建任务。\n\n${truncate(command.message, 300)}`,
          template: "yellow",
          status: "等待恢复",
          action: { text: "查看队列", action: "queue" }
        }), { operationId: operation.id });
      }
      return this.#createTaskNow(command, event, { attachments });
    }

    if (command.type === "send" && !this.codex.ready) {
      if (!command.message || command.message.length > 4_000) throw new Error("后续消息长度需要在 1–4000 个字符之间");
      const threadId = resolveThreadId(command.selector, this.state.getChat(event.chat_id), []);
      if (!threadId) throw new Error("当前没有选中的任务，请先发送“任务”并打开一条任务");
      const operation = this.state.enqueueOperation({
        type: "send",
        threadId,
        text: command.message,
        attachments,
        chatId: event.chat_id,
        sourceMessageId: event.message_id,
        senderId: event.sender_id ?? event.operator_id
      }, this.config.maxOfflineOperations ?? 50);
      this.state.bindMessage(event.message_id, { threadId, chatId: event.chat_id, kind: "offline-send" });
      await this.state.save();
      return card(noticeCard({
        title: "消息已进入离线队列",
        message: "Codex 恢复后会自动发送到当前任务，不需要重复提交。",
        template: "yellow",
        status: "等待恢复",
        action: { text: "查看队列", action: "queue" }
      }), { threadId, operationId: operation.id });
    }

    this.#requireCodex();
    const { threadId, thread } = await this.#selectedThread(command.selector, event);

    if (command.type === "progress") {
      if (!fromAction && isActive(thread)) this.#watchThread(thread, event);
      await this.state.save();
      return card(progressCard(thread, { watching: this.state.isWatching(threadId), queue: this.state.queuedFor(threadId) }), { threadId });
    }
    if (command.type === "progress_detail") {
      if (!fromAction && isActive(thread)) this.#watchThread(thread, event);
      await this.state.save();
      return this.#progressDetailResponse(thread, {
        turnId: command.turnId,
        cursor: command.cursor
      });
    }
    if (command.type === "watch") {
      if (!isActive(thread)) {
        return card(noticeCard({
          title: "任务当前未运行",
          message: "任务没有正在执行的回合，无需关注完成通知。",
          template: "grey",
          status: "未关注",
          action: { text: "查看任务", action: "progress", value: { threadId } }
        }), { threadId });
      }
      this.#watchThread(thread, event);
      await this.state.save();
      return card(progressCard(thread, { watching: true, queue: this.state.queuedFor(threadId) }), { threadId });
    }
    if (command.type === "unwatch") {
      this.state.unwatchThread(threadId);
      await this.state.save();
      return card(progressCard(thread, { watching: false, queue: this.state.queuedFor(threadId) }), { threadId });
    }
    if (command.type === "send_form") return card(sendMessageFormCard(thread), { threadId });
    if (command.type === "send") {
      return this.#sendTaskNow(command, event, threadId, thread, attachments);
    }
    if (command.type === "archive") {
      if (isActive(thread)) throw new Error("运行中的任务不能归档，请先停止或等待完成");
      await this.codex.archiveThread(threadId);
      this.state.unwatchThread(threadId);
      await this.state.save();
      return card(noticeCard({ title: "任务已归档", message: `${threadTitle(thread)}\n需要恢复时发送：恢复归档 ${threadId}`, template: "green", status: "已归档", action: { text: "任务首页", action: "home" } }), { threadId });
    }
    if (command.type === "unarchive") {
      await this.codex.unarchiveThread(threadId);
      return card(noticeCard({
        title: "任务已恢复",
        message: threadTitle(thread),
        template: "green",
        status: "已恢复",
        action: { text: "查看任务", action: "progress", value: { threadId } }
      }), { threadId });
    }
    if (command.type === "stop") {
      if (!confirmed) return card(stopConfirmCard(thread), { threadId });
      if (isDesktopActive(thread)) throw new Error("这个回合由 Codex Desktop 运行，不能从桥接进程安全中断，请回 Desktop 操作");
      const turnId = currentTurnId(thread);
      if (!turnId || !isActive(thread)) throw new Error("任务当前没有可停止的运行回合");
      await this.codex.interruptThread(threadId, turnId);
      return card(noticeCard({
        title: "已发送停止请求",
        message: "当前回合正在中断；已有文件修改不会自动撤销。",
        template: "yellow",
        status: "停止中",
        action: { text: "查看任务", action: "progress", value: { threadId } }
      }), { threadId });
    }
    if (command.type === "queue_cancel") {
      const removed = this.state.cancelQueue(threadId);
      await this.state.save();
      return card(noticeCard({ title: "已取消排队消息", message: removed.length ? `已移除 ${removed.length} 条等待发送的消息。` : "该任务没有排队消息。", template: "grey", status: "已处理", action: { text: "查看队列", action: "queue" } }), { threadId });
    }
    return card(helpCard());
  }

  #validateCreate(command) {
    if (!this.config.workspaces[command.workspace]) {
      throw new Error(`未知项目“${command.workspace}”。可选项目：${Object.keys(this.config.workspaces).join("、")}`);
    }
    if (!command.message || command.message.length > 4_000) throw new Error("任务需求长度需要在 1–4000 个字符之间");
  }

  async #createTaskNow(command, event, {
    attachments = [],
    operation = null,
    background = false
  } = {}) {
    this.#validateCreate(command);
    const workspace = this.config.workspaces[command.workspace];
    const name = truncate(command.message.split("\n")[0].replaceAll(/\s+/g, " ").trim(), 64);
    const created = await this.codex.createTask({
      cwd: workspace,
      prompt: command.message,
      name,
      effort: command.effort ?? "default",
      attachments,
      clientUserMessageId: operation?.id ?? event.message_id ?? null,
      existingThreadId: operation?.threadId ?? null,
      onThreadStarted: operation ? async (threadId) => {
        this.state.updateOperation(operation.id, { threadId });
        await this.state.save();
      } : null
    });
    const thread = { ...created.thread, cwd: workspace, status: { type: "active" }, turns: [created.turn] };
    if (!background) this.state.selectThread(event.chat_id, thread.id);
    const recentIds = this.state.getChat(event.chat_id).recentThreadIds ?? [];
    this.state.setRecentThreads(event.chat_id, [thread.id, ...recentIds.filter((id) => id !== thread.id)].slice(0, this.config.recentThreadLimit));
    this.state.bindMessage(event.message_id, { threadId: thread.id, chatId: event.chat_id, kind: background ? "scheduled-source" : "task-source" });
    this.#watchThread(thread, event, created.turn.id);
    await this.state.save();
    await this.#syncDesktopThread(thread.id);
    return card(progressCard(thread, { watching: true, queue: [] }), { threadId: thread.id });
  }

  async #sendTaskNow(command, event, threadId, thread, attachments = []) {
    if (!command.message || command.message.length > 4_000) throw new Error("后续消息长度需要在 1–4000 个字符之间");
    const knownTurnId = currentTurnId(thread) ?? this.state.getWatch(threadId)?.turnId ?? null;
    const shouldQueue = isDesktopActive(thread) ||
      (isActive(thread) && attachments.length > 0) ||
      (isActive(thread) && !knownTurnId);
    if (shouldQueue) {
      return this.#queueThreadMessage(threadId, thread, command.message, event, attachments,
        isDesktopActive(thread) ? "当前回合由 Codex Desktop 运行" :
          attachments.length ? "附件会在当前回合结束后作为独立回合发送" :
            "当前回合 ID 仍在同步");
    }

    let turn;
    try {
      turn = await this.codex.sendMessage(threadId, command.message, thread, {
        expectedTurnId: knownTurnId,
        attachments,
        clientUserMessageId: event.message_id ?? null
      });
    } catch (error) {
      if (/同步当前回合|找不到.*回合|current turn|expectedTurnId/i.test(error.message)) {
        return this.#queueThreadMessage(threadId, thread, command.message, event, attachments, "当前回合刚发生切换");
      }
      throw error;
    }
    this.state.selectThread(event.chat_id, threadId);
    this.state.bindMessage(event.message_id, { threadId, chatId: event.chat_id, kind: "task-message" });
    this.#watchThread({ ...thread, status: { type: "active" } }, event, turn.id);
    await this.state.save();
    await this.#syncDesktopThread(threadId);
    return card(noticeCard({
      title: "已发送给 Codex",
      message: `任务：${threadTitle(thread)}\n完成或失败后会在这里通知。`,
      template: "green",
      status: "已发送",
      action: { text: "查看进度", action: "progress", value: { threadId } }
    }), { threadId });
  }

  async #queueThreadMessage(threadId, thread, text, event, attachments, reason) {
    const queued = this.state.enqueue(threadId, {
      text,
      attachments,
      chatId: event.chat_id,
      sourceMessageId: event.message_id,
      senderId: event.sender_id ?? event.operator_id
    }, this.config.maxQueuedMessagesPerThread);
    this.state.selectThread(event.chat_id, threadId);
    this.state.bindMessage(event.message_id, { threadId, chatId: event.chat_id, kind: "queued-message" });
    this.#watchThread(thread, event, currentTurnId(thread) ?? thread.rollout?.turnId ?? null);
    await this.state.save();
    return card(noticeCard({
      title: "消息已加入队列",
      message: `${reason}。结束后会自动发送，不需要重试。\n\n${truncate(queued.text, 300)}`,
      template: "yellow",
      status: "排队中",
      action: { text: "查看队列", action: "queue" }
    }), { threadId });
  }

  #resolveSchedule(selector, chatId) {
    const chat = this.state.getChat(chatId);
    const id = /^\d+$/.test(selector ?? "") ? chat.recentScheduleIds?.[Number(selector) - 1] : selector;
    const schedule = this.state.getSchedule(id);
    if (!schedule || schedule.chatId !== chatId) throw new Error("找不到这个定时任务，请先发送“定时任务”刷新列表");
    return schedule;
  }

  #bindEvents() {
    this.codex.on("log", (line) => this.logger.warn("Codex log", { detail: line }));
    this.codex.on("ready", () => {
      this.codexReconnectAttempt = 0;
      this.detailItemsApiSupported = true;
      this.logger.info("Codex app-server ready");
      this.#track(this.#drainOperations().catch((error) => this.#logError("offline operation recovery failed", error)));
    });
    this.codex.on("turn/completed", (params) => this.#track(
      this.#handleTurnCompleted(params).catch((error) => this.#logError("completion handling failed", error))
    ));
    this.codex.on("notification", (message) => {
      if (this.progressTracker.ingest(message.method, message.params)) {
        this.#scheduleDetailCardUpdate(message.params.threadId);
      }
    });
    this.codex.on("serverRequest", (request) => this.#track(
      this.#handleServerRequest(request).catch((error) => this.#logError("server request handling failed", error))
    ));
    this.codex.on("exit", (error) => {
      this.#logError("Codex app-server exited", error);
      if (!this.shuttingDown) this.#scheduleCodexReconnect();
    });

    this.lark.on("log", (line) => {
      if (/ready event_key=|listening for events|connected|consuming as|to stop gracefully/.test(line)) this.logger.info("Lark log", { detail: line });
      else this.logger.warn("Lark log", { detail: line });
    });
    this.lark.on("ready", (eventKey) => {
      this.readyEventKeys.add(eventKey);
      this.larkReconnectAttempts.set(eventKey, 0);
      this.logger.info("Lark event consumer ready", { eventKey });
    });
    this.lark.on("event", (envelope) => this.#track(
      this.#handleEvent(envelope).catch((error) => this.#logError("event handling failed", error))
    ));
    this.lark.on("exit", ({ eventKey, error }) => {
      this.readyEventKeys.delete(eventKey);
      this.#logError("Lark event consumer exited", error, { eventKey });
      if (!this.shuttingDown) this.#scheduleLarkReconnect(eventKey);
    });
  }

  #track(promise) {
    this.activeTasks.add(promise);
    promise.finally(() => this.activeTasks.delete(promise));
    return promise;
  }

  async #handleEvent(envelope) {
    if (envelope.eventKey === "im.message.receive_v1") return this.#handleMessage(envelope);
    if (envelope.eventKey === "card.action.trigger") return this.#handleCardAction(envelope);
    envelope.ack();
  }

  async #handleMessage({ event, ack }) {
    const eventId = event.message_id;
    if (!this.#authorizedMessage(event)) {
      ack();
      return;
    }
    if (!this.state.beginProcessing(eventId)) {
      ack();
      return;
    }
    this.lastMessageAt = Date.now();
    this.state.recordChat(event.chat_id, { chatType: event.chat_type, senderId: event.sender_id });
    let response;
    try {
      let attachments = [];
      let transcript = null;
      if (eventHasResources(event)) {
        const ingested = await this.attachments.ingest(event, this.lark);
        attachments = ingested.attachments;
        transcript = ingested.transcript;
      }
      const content = normalizedEventContent(event, transcript, attachments.length > 0);
      let command = SUPPORTED_MESSAGE_TYPES.has(event.message_type ?? "text") ?
        parseCommand(content) :
        { type: "unsupported_message" };
      if (command.type === "unknown") {
        command = routeNaturalMessage({
          content,
          chatState: this.state.getChat(event.chat_id),
          boundThreadId: this.#boundThreadId(event),
          workspaces: this.config.workspaces,
          workspaceAliases: this.config.workspaceAliases,
          defaultWorkspace: this.config.defaultWorkspace,
          hasAttachments: attachments.length > 0
        });
      }
      this.logger.info("Feishu message routed", {
        eventId,
        chatId: event.chat_id,
        messageType: event.message_type,
        commandType: command.type,
        routeReason: command.routeReason,
        attachmentCount: attachments.length
      });
      response = await this.executeCommand(command, event, { attachments });
    } catch (error) {
      this.#logError("message command failed", error, { eventId, command: event.content });
      response = card(noticeCard({ title: "处理失败", message: error.message, template: "red", status: "失败", action: { text: "健康检查", action: "health" } }));
    }
    if (response.threadId) {
      this.state.bindMessage(event.message_id, { threadId: response.threadId, chatId: event.chat_id, kind: "source" });
    }
    await this.state.finishProcessing(eventId);
    try {
      const sent = await this.#reply(event.message_id, response, `reply-${event.message_id}`);
      if (response.threadId && sent?.message_id) {
        this.state.bindMessage(sent.message_id, { threadId: response.threadId, chatId: event.chat_id, kind: "bot-reply" });
        await this.state.save();
      }
      this.lastReplyAt = Date.now();
    } catch (error) {
      this.#logError("Feishu reply failed", error, { eventId });
    }
    ack();
  }

  async #handleCardAction({ event, ack }) {
    const eventId = event.event_id;
    if (!this.#authorizedAction(event)) {
      ack();
      return;
    }
    if (!this.state.beginProcessing(eventId)) {
      ack();
      return;
    }
    this.lastMessageAt = Date.now();
    this.state.recordChat(event.chat_id, { chatType: "p2p", senderId: event.operator_id });
    const value = parseActionValue(event.action_value);
    const form = parseActionValue(event.form_value);
    const action = value.action ?? ({ create_submit: "create", send_submit: "send" }[event.action_name]);
    this.logger.info("Feishu card action received", { eventId, chatId: event.chat_id, action });
    let response;
    try {
      if (MUTATING_ACTIONS.has(action) && value.ts && Date.now() - Number(value.ts) > 24 * 60 * 60_000) {
        throw new Error("这张卡片已过期，请刷新后重试");
      }
      const command = this.#commandFromAction(action, value, form);
      response = await this.executeCommand(command, {
        chat_id: event.chat_id,
        message_id: event.message_id,
        operator_id: event.operator_id,
        sender_id: event.operator_id
      }, { fromAction: true, confirmed: action === "stop" });
    } catch (error) {
      this.#logError("card action failed", error, { eventId, action });
      response = card(noticeCard({ title: "操作失败", message: error.message, template: "red", status: "失败", action: { text: "任务首页", action: "home" } }));
    }
    if (response.threadId) {
      this.state.bindMessage(event.message_id, { threadId: response.threadId, chatId: event.chat_id, kind: "interactive-card" });
    }
    await this.state.finishProcessing(eventId, "event");
    try {
      if (response.type === "card" && event.token) {
        await this.lark.updateCard(event.token, response.content);
        if (response.detailView && response.threadId) {
          this.#subscribeDetailCard({
            messageId: event.message_id,
            chatId: event.chat_id,
            token: event.token,
            threadId: response.threadId,
            turnId: response.turnId,
            cursor: response.cursor
          });
        } else {
          this.detailSubscriptions.delete(event.message_id);
        }
      } else {
        this.detailSubscriptions.delete(event.message_id);
        const sent = await this.#reply(event.message_id, response, `action-${eventId}`);
        if (response.threadId && sent?.message_id) {
          this.state.bindMessage(sent.message_id, { threadId: response.threadId, chatId: event.chat_id, kind: "bot-reply" });
          await this.state.save();
        }
      }
      this.lastReplyAt = Date.now();
    } catch (error) {
      this.detailSubscriptions.delete(event.message_id);
      this.#logError("card update failed", error, { eventId });
      await this.#reply(event.message_id, response, `action-fallback-${eventId}`).catch((fallbackError) => this.#logError("card fallback reply failed", fallbackError, { eventId }));
    }
    ack();
  }

  #commandFromAction(action, value, form) {
    if (action === "home") return { type: "list", filter: value.filter ?? null };
    if (action === "create_form") return { type: "create_form" };
    if (action === "create") return { type: "create", workspace: form.workspace, message: form.prompt, effort: form.effort ?? "default" };
    if (action === "progress") return { type: "progress", selector: value.threadId };
    if (action === "progress_detail") return {
      type: "progress_detail",
      selector: value.threadId,
      turnId: value.turnId ?? null,
      cursor: value.cursor ?? null
    };
    if (action === "watch") return { type: "watch", selector: value.threadId };
    if (action === "unwatch") return { type: "unwatch", selector: value.threadId };
    if (action === "send_form") return { type: "send_form", selector: value.threadId };
    if (action === "send") return { type: "send", selector: value.threadId ?? form.target_thread, message: form.message };
    if (action === "archive") return { type: "archive", selector: value.threadId };
    if (action === "stop") return { type: "stop", selector: value.threadId };
    if (action === "queue") return { type: "queue_list" };
    if (action === "queue_cancel") return { type: "queue_cancel", selector: value.threadId };
    if (action === "health") return { type: "health" };
    if (action === "clarify_continue") return { type: "resolve_intent", pendingId: value.pendingId, resolution: "continue" };
    if (action === "clarify_create") return { type: "resolve_intent", pendingId: value.pendingId, resolution: "create" };
    if (action === "clarify_cancel") return { type: "resolve_intent", pendingId: value.pendingId, resolution: "cancel" };
    if (action === "schedule_list") return { type: "schedule_list" };
    if (action === "schedule_detail") return { type: "schedule_detail", scheduleId: value.scheduleId };
    if (action === "schedule_pause") return { type: "schedule_pause", scheduleId: value.scheduleId };
    if (action === "schedule_resume") return { type: "schedule_resume", scheduleId: value.scheduleId };
    if (action === "schedule_cancel") return { type: "schedule_cancel", scheduleId: value.scheduleId };
    return { type: "unknown", raw: action ?? "" };
  }

  async #progressDetailResponse(thread, { turnId = null, cursor = null } = {}) {
    const selectedTurn = turnId ? thread.turns?.find((turn) => turn.id === turnId) :
      thread.turns?.findLast((turn) => turn.status === "inProgress") ?? latestTurn(thread);
    const selectedTurnId = selectedTurn?.id ?? turnId ?? thread.rollout?.turnId ?? null;
    const page = await this.#loadDetailPage(thread, selectedTurnId, cursor);
    const detail = this.progressTracker.snapshot(thread, {
      turnId: selectedTurnId,
      page,
      cursor
    });
    return card(progressDetailCard(thread, detail, {
      queue: this.state.queuedFor(thread.id)
    }), {
      threadId: thread.id,
      detailView: true,
      turnId: detail.turnId,
      cursor: detail.page.cursor
    });
  }

  async #loadDetailPage(thread, turnId, cursor) {
    if (turnId && this.detailItemsApiSupported && typeof this.codex.listThreadItems === "function") {
      try {
        return await this.codex.listThreadItems(thread.id, {
          turnId,
          limit: DETAIL_ITEM_PAGE_SIZE,
          cursor,
          sortDirection: "desc"
        });
      } catch (error) {
        if (/not supported yet|method not found|unknown method/i.test(error.message)) {
          this.detailItemsApiSupported = false;
          this.logger.info("Codex detail item paging is unavailable; using thread snapshot pagination", {
            threadId: thread.id
          });
        } else {
          this.logger.warn("Codex detail item page failed", { threadId: thread.id, turnId, error: error.message });
        }
      }
    }

    const turn = turnId ? thread.turns?.find((item) => item.id === turnId) : latestTurn(thread);
    const items = [...(turn?.items ?? [])].reverse();
    const offset = /^local:(\d+)$/.test(cursor ?? "") ? Number(cursor.slice(6)) : 0;
    const pageItems = items.slice(offset, offset + DETAIL_ITEM_PAGE_SIZE);
    const nextOffset = offset + pageItems.length;
    return {
      items: pageItems,
      nextCursor: nextOffset < items.length ? `local:${nextOffset}` : null,
      backwardsCursor: offset > 0 ? `local:${Math.max(0, offset - DETAIL_ITEM_PAGE_SIZE)}` : null
    };
  }

  #subscribeDetailCard({ messageId, chatId, token, threadId, turnId, cursor }) {
    this.detailSubscriptions.set(messageId, {
      messageId,
      chatId,
      token,
      threadId,
      turnId,
      cursor: cursor ?? null,
      autoRefresh: !cursor,
      expiresAt: Date.now() + (this.config.detailCardTokenTtlMs ?? 20 * 60_000)
    });
  }

  #scheduleDetailCardUpdate(threadId) {
    if (![...this.detailSubscriptions.values()].some((subscription) => subscription.threadId === threadId && subscription.autoRefresh)) return;
    if (this.detailUpdateTimers.has(threadId)) return;
    const timer = setTimeout(() => {
      this.detailUpdateTimers.delete(threadId);
      this.#track(this.#refreshDetailCards(threadId).catch((error) => this.#logError("detail card refresh failed", error, { threadId })));
    }, this.config.detailUpdateDebounceMs ?? 2_000);
    this.detailUpdateTimers.set(threadId, timer);
  }

  async #refreshDetailCards(threadId) {
    const now = Date.now();
    const subscriptions = [...this.detailSubscriptions.values()].filter((subscription) =>
      subscription.threadId === threadId && subscription.autoRefresh
    );
    for (const subscription of subscriptions) {
      if (subscription.expiresAt <= now) {
        this.detailSubscriptions.delete(subscription.messageId);
        continue;
      }
      try {
        const thread = await this.#enrichThread(await this.codex.readThread(threadId));
        const response = await this.#progressDetailResponse(thread, {
          turnId: subscription.turnId,
          cursor: null
        });
        await this.lark.updateCard(subscription.token, response.content);
      } catch (error) {
        this.detailSubscriptions.delete(subscription.messageId);
        this.logger.warn("Live detail card update stopped", {
          threadId,
          messageId: subscription.messageId,
          error: error.message
        });
      }
    }
  }

  async #recentThreads() {
    return Promise.all((await this.codex.listThreads(this.config.recentThreadLimit)).map((thread) => this.#enrichThread(thread)));
  }

  async #selectedThread(selector, event) {
    const recentThreads = await this.#recentThreads();
    const threadId = resolveThreadId(selector, this.state.getChat(event.chat_id), recentThreads);
    if (!threadId) throw new Error("没有可用的 Codex 任务，请先发送“任务”查看列表");
    this.state.selectThread(event.chat_id, threadId);
    const existing = recentThreads.find((thread) => thread.id === threadId);
    const detailed = await this.codex.readThread(threadId);
    const thread = await this.#enrichThread({ ...(existing ?? {}), ...detailed, id: threadId });
    return { threadId, thread };
  }

  #boundThreadId(event) {
    for (const messageId of [event.reply_to, event.root_id]) {
      const binding = this.state.getMessageBinding(messageId);
      if (binding?.chatId === event.chat_id) return binding.threadId;
    }
    return null;
  }

  async #syncDesktopThread(threadId) {
    try {
      const refreshed = await this.desktopSync.refreshThread(threadId);
      if (refreshed) this.logger.info("Codex Desktop task refreshed", { threadId });
    } catch (error) {
      this.logger.warn("Codex Desktop task refresh failed", { threadId, error: error.message });
    }
  }

  #watchThread(thread, event, turnId = currentTurnId(thread)) {
    this.state.watchThread(thread.id, {
      chatId: event.chat_id,
      messageId: event.message_id,
      senderId: event.sender_id ?? event.operator_id,
      turnId,
      rolloutPath: thread.path ?? null
    });
  }

  async #queueCard() {
    const items = this.state.allQueued();
    const titleLookup = new Map();
    await Promise.all([...new Set(items.map((item) => item.threadId))].map(async (threadId) => {
      try {
        titleLookup.set(threadId, threadTitle(await this.codex.readThread(threadId)));
      } catch {
        titleLookup.set(threadId, threadId.slice(0, 8));
      }
    }));
    return queueCard(items, titleLookup, this.state.allOperations());
  }

  async #handleTurnCompleted({ threadId, turn }) {
    const watch = this.state.getWatch(threadId);
    if (!watch || watch.notified) {
      await this.#releaseCodexThread(threadId);
      return;
    }
    if (watch.turnId && watch.turnId !== turn.id) return;
    await this.#notifyCompletion(threadId, turn.status, watch);
  }

  async #poll() {
    await this.#pollSchedules();
    await this.#drainOperations();
    await this.#pollWatches();
    if (Date.now() - this.lastAttachmentCleanupAt > 24 * 60 * 60_000) {
      await this.attachments.cleanup(Date.now(), this.#protectedAttachmentPaths());
      this.lastAttachmentCleanupAt = Date.now();
    }
  }

  #protectedAttachmentPaths() {
    const containers = [
      ...this.state.allQueued(),
      ...this.state.allOperations(),
      ...Object.values(this.state.state.pendingIntents)
    ];
    return containers.flatMap((container) => container.attachments ?? []).map((attachment) => attachment.path).filter(Boolean);
  }

  async #pollSchedules(now = Date.now()) {
    if (this.schedulePolling) return;
    this.schedulePolling = true;
    let changed = false;
    try {
      for (const schedule of Object.values(this.state.state.schedules)) {
        if (schedule.status !== "active" || Number(schedule.nextRunAt) > now) continue;
        const dueAt = Number(schedule.nextRunAt);
        const overdue = now - dueAt;
        if (overdue > (this.config.scheduleCatchUpWindowMs ?? 21_600_000)) {
          if (schedule.spec.kind === "once") {
            this.state.updateSchedule(schedule.id, { status: "missed", lastError: "设备离线时间超过补偿窗口" });
          } else {
            this.state.updateSchedule(schedule.id, {
              nextRunAt: nextScheduleRun(schedule.spec, new Date(now), schedule.timeZone),
              lastSkippedAt: dueAt
            });
          }
          changed = true;
          continue;
        }

        const operationId = `schedule-${schedule.id}-${dueAt}`;
        this.state.enqueueOperation({
          id: operationId,
          type: "create",
          workspace: schedule.workspace,
          text: schedule.prompt,
          effort: "default",
          attachments: [],
          chatId: schedule.chatId,
          sourceMessageId: schedule.sourceMessageId,
          senderId: schedule.senderId,
          scheduleId: schedule.id,
          scheduledFor: dueAt,
          background: true
        }, this.config.maxOfflineOperations ?? 50);
        this.state.updateSchedule(schedule.id, schedule.spec.kind === "once" ? {
          status: "queued",
          lastEnqueuedAt: dueAt
        } : {
          lastEnqueuedAt: dueAt,
          nextRunAt: nextScheduleRun(schedule.spec, new Date(dueAt + 1_000), schedule.timeZone)
        });
        changed = true;
      }
      if (changed) await this.state.save();
    } finally {
      this.schedulePolling = false;
    }
  }

  async #drainOperations() {
    if (this.operationDispatching || !this.codex.ready) return;
    this.operationDispatching = true;
    try {
      for (const operation of this.state.pendingOperations().slice(0, 10)) {
        this.state.updateOperation(operation.id, { status: "dispatching" });
        await this.state.save();
        if (operation.scheduleId && this.state.getSchedule(operation.scheduleId)?.status === "canceled") {
          this.state.completeOperation(operation.id);
          await this.state.save();
          continue;
        }
        try {
          const event = {
            chat_id: operation.chatId,
            message_id: operation.sourceMessageId,
            sender_id: operation.senderId
          };
          let response;
          if (operation.type === "create") {
            response = await this.#createTaskNow({
              type: "create",
              workspace: operation.workspace,
              message: operation.text,
              effort: operation.effort
            }, event, {
              attachments: operation.attachments ?? [],
              operation,
              background: operation.background === true
            });
          } else if (operation.type === "send") {
            const detailed = await this.codex.readThread(operation.threadId);
            const thread = await this.#enrichThread(detailed);
            response = await this.#sendTaskNow({
              type: "send",
              selector: operation.threadId,
              message: operation.text
            }, event, operation.threadId, thread, operation.attachments ?? []);
          } else {
            throw new Error(`未知离线操作类型：${operation.type}`);
          }

          this.state.completeOperation(operation.id);
          if (operation.scheduleId) {
            const schedule = this.state.getSchedule(operation.scheduleId);
            if (schedule) {
              this.state.updateSchedule(schedule.id, {
                status: schedule.spec.kind === "once" ? "completed" : "active",
                lastRunAt: Date.now(),
                lastThreadId: response.threadId,
                lastError: null
              });
            }
          }
          await this.state.save();

          let sent;
          if (operation.background) {
            sent = await this.lark.sendCard({
              chatId: operation.chatId,
              card: response.content,
              idempotencyKey: `operation-${operation.id}`.slice(0, 50)
            });
          } else if (operation.sourceMessageId) {
            sent = await this.lark.replyCard(
              operation.sourceMessageId,
              response.content,
              `operation-${operation.id}`.slice(0, 50)
            );
          }
          if (response.threadId && sent?.message_id) {
            this.state.bindMessage(sent.message_id, { threadId: response.threadId, chatId: operation.chatId, kind: "recovered-operation" });
            if (operation.background) {
              const watch = this.state.getWatch(response.threadId);
              if (watch) this.state.watchThread(response.threadId, { ...watch, messageId: sent.message_id });
            }
            await this.state.save();
          }
          this.logger.info("Queued operation dispatched", { operationId: operation.id, type: operation.type, threadId: response.threadId });
        } catch (error) {
          const failed = this.state.failOperation(operation.id, error);
          if (operation.scheduleId) {
            const schedule = this.state.getSchedule(operation.scheduleId);
            this.state.updateSchedule(operation.scheduleId, {
              lastError: error.message,
              ...(failed?.status === "failed" && schedule?.spec.kind === "once" ? { status: "failed" } : {})
            });
          }
          await this.state.save();
          this.#logError("queued operation dispatch failed", error, { operationId: operation.id, attempts: failed?.attempts });
          if (failed?.status === "failed") {
            await this.#notifyOperationFailure(failed).catch((notifyError) => this.#logError("operation failure notification failed", notifyError, { operationId: operation.id }));
          }
        }
      }
    } finally {
      this.operationDispatching = false;
    }
  }

  async #notifyOperationFailure(operation) {
    const resultCard = noticeCard({
      title: "排队操作未能完成",
      message: `${operation.type === "create" ? "新建任务" : "继续任务"}已重试 5 次。\n${operation.lastError}`,
      template: "red",
      status: "需要处理",
      action: { text: "查看队列", action: "queue" }
    });
    if (operation.sourceMessageId) {
      await this.lark.replyCard(operation.sourceMessageId, resultCard, `operation-failed-${operation.id}`.slice(0, 50));
    } else {
      await this.lark.sendCard({ chatId: operation.chatId, card: resultCard, idempotencyKey: `operation-failed-${operation.id}`.slice(0, 50) });
    }
  }

  async #pollWatches() {
    if (!this.codex.ready) return;
    for (const watch of this.state.activeWatches()) {
      try {
        if (watch.rolloutPath) {
          const rollout = await readRolloutSnapshot(watch.rolloutPath);
          if ((!watch.turnId || rollout?.turnId === watch.turnId) && rollout?.status === "completed") {
            const thread = await this.#enrichThread(await this.codex.readThread(watch.threadId));
            await this.#notifyCompletion(watch.threadId, "completed", watch, thread, rollout.result);
            continue;
          }
        }
        const thread = await this.#enrichThread(await this.codex.readThread(watch.threadId));
        const turn = latestTurn(thread);
        if (!turn || turn.status === "inProgress") continue;
        if (watch.turnId && watch.turnId !== turn.id) continue;
        await this.#notifyCompletion(watch.threadId, turn.status, watch, thread);
      } catch (error) {
        this.#logError("watch poll item failed", error, { threadId: watch.threadId });
      }
    }
  }

  async #notifyCompletion(threadId, turnStatus, watch, existingThread, resultOverride = "") {
    const thread = existingThread ?? await this.#enrichThread(await this.codex.readThread(threadId));
    const next = this.state.queuedFor(threadId)[0];
    if (next) {
      const turn = await this.codex.sendMessage(threadId, next.text, thread, {
        clientUserMessageId: next.id,
        attachments: next.attachments ?? []
      });
      this.state.shiftQueue(threadId);
      this.state.watchThread(threadId, {
        chatId: next.chatId,
        messageId: next.sourceMessageId,
        senderId: next.senderId,
        turnId: turn.id,
        rolloutPath: thread.path ?? null
      });
      await this.state.save();
      await this.#syncDesktopThread(threadId);
      this.logger.info("Queued Codex message dispatched", { threadId, queueId: next.id, turnId: turn.id });
      if (!this.state.isMuted()) {
        const sent = await this.lark.replyCard(next.sourceMessageId, noticeCard({
          title: "排队消息已发送",
          message: `上一回合已结束，已自动发送：\n\n${truncate(next.text, 300)}`,
          template: "green",
          status: "已继续",
          action: { text: "查看进度", action: "progress", value: { threadId } }
        }), `queue-sent-${next.id}`);
        if (sent?.message_id) {
          this.state.bindMessage(sent.message_id, { threadId, chatId: next.chatId, kind: "queue-dispatched" });
          await this.state.save();
        }
      }
      return;
    }

    if (this.state.isMuted()) {
      this.state.markNotified(threadId);
      await this.state.save();
      this.logger.info("Codex completion notification muted", { threadId, turnStatus });
      await this.#releaseCodexThread(threadId);
      return;
    }
    try {
      await this.#syncDesktopThread(threadId);
      const resultCard = completionCard(thread, turnStatus, resultOverride);
      const sent = watch.messageId ?
        await this.lark.replyCard(watch.messageId, resultCard, `done-${threadId}-${watch.turnId ?? "latest"}`) :
        await this.lark.sendCard({ chatId: watch.chatId, card: resultCard, idempotencyKey: `done-${threadId}-${watch.turnId ?? "latest"}` });
      if (sent?.message_id) this.state.bindMessage(sent.message_id, { threadId, chatId: watch.chatId, kind: "completion" });
      this.state.markNotified(threadId);
      await this.state.save();
      this.logger.info("Codex completion notification sent", { threadId, turnStatus });
    } finally {
      await this.#releaseCodexThread(threadId);
    }
  }

  async #releaseCodexThread(threadId) {
    if (typeof this.codex.unsubscribeThread !== "function") return;
    try {
      const result = await this.codex.unsubscribeThread(threadId);
      this.logger.info("Released Codex task writer", { threadId, status: result?.status ?? "unknown" });
    } catch (error) {
      this.logger.warn("Codex task writer release failed", { threadId, error: error.message });
    }
  }

  async #handleServerRequest(request) {
    this.codex.respondError(request.id, "Remote approval and user-input requests are disabled in the Feishu bridge");
    const threadId = request.params?.threadId;
    const turnId = request.params?.turnId ?? this.state.getWatch(threadId)?.turnId ?? null;
    if (threadId && turnId) {
      this.progressTracker.markAttention(threadId, turnId, "需要回 Codex Desktop 处理权限或输入请求");
      this.#scheduleDetailCardUpdate(threadId);
    }
    const watch = threadId ? this.state.getWatch(threadId) : null;
    if (!watch || this.state.isMuted()) return;
    await this.lark.replyCard(watch.messageId, noticeCard({
      title: "任务需要你处理",
      message: "Codex 请求了飞书助手不允许代办的权限或输入。请求已安全拒绝；如需继续，请回 Codex Desktop 查看任务。",
      template: "yellow",
      status: "需要处理",
      action: { text: "查看进度", action: "progress", value: { threadId } }
    }), `attention-${threadId}-${request.id}`);
  }

  async #enrichThread(thread) {
    if (!thread?.path) return thread;
    try {
      const rollout = await readRolloutSnapshot(thread.path);
      return rollout ? { ...thread, rollout } : thread;
    } catch (error) {
      this.logger.warn("Rollout read failed", { threadId: thread.id, error: error.message });
      return thread;
    }
  }

  #authorizedMessage(event) {
    if (event.sender_type !== "user" || !event.message_id || !event.chat_id) return false;
    if (!this.config.allowedUserIds.includes(event.sender_id)) {
      this.logger.warn("Ignored unauthorized Feishu user", { senderId: event.sender_id });
      return false;
    }
    if (this.config.requireP2P && event.chat_type !== "p2p") {
      this.logger.warn("Ignored non-p2p Feishu message", { chatId: event.chat_id, chatType: event.chat_type });
      return false;
    }
    if (this.config.allowedChatIds.length > 0 && !this.config.allowedChatIds.includes(event.chat_id)) {
      this.logger.warn("Ignored unauthorized Feishu chat", { chatId: event.chat_id });
      return false;
    }
    return true;
  }

  #authorizedAction(event) {
    if (!event.event_id || !event.operator_id || !event.message_id || !event.chat_id) return false;
    if (!this.config.allowedUserIds.includes(event.operator_id)) {
      this.logger.warn("Ignored unauthorized card operator", { operatorId: event.operator_id });
      return false;
    }
    if (this.config.allowedChatIds.length > 0 && !this.config.allowedChatIds.includes(event.chat_id)) return false;
    return true;
  }

  #requireCodex() {
    if (!this.codex.ready) throw new Error("Codex 服务正在重连，请稍后重试；可发送“健康”查看状态");
  }

  #health() {
    return {
      version: VERSION,
      uptime: durationLabel(Date.now() - this.startedAt),
      codexReady: Boolean(this.codex.ready),
      larkReady: EVENT_KEYS.every((key) => this.readyEventKeys.has(key)),
      queuedCount: this.state.allQueued().length + this.state.allOperations().length,
      watchCount: this.state.activeWatches().length,
      scheduleCount: Object.values(this.state.state.schedules).filter((schedule) => schedule.status === "active").length,
      lastMessageAt: this.lastMessageAt,
      lastReplyAt: this.lastReplyAt,
      lastError: this.logger.lastError?.message ?? null,
      codexRecovery: this.codexDaemon?.snapshot?.() ?? null
    };
  }

  async #reply(messageId, response, idempotencyKey) {
    if (response.type === "card") return this.lark.replyCard(messageId, response.content, idempotencyKey);
    return this.lark.replyMarkdown(messageId, response.content, idempotencyKey);
  }

  async #startCodex() {
    if (this.codexStarting || this.codex.ready || this.shuttingDown) return;
    this.codexStarting = true;
    try {
      if (this.codexDaemon) {
        try {
          const recovery = await this.codexDaemon.ensureRunning();
          if (recovery.attempted) this.logger.info("Codex daemon start requested", { status: recovery.status });
        } catch (error) {
          this.#logError("Codex daemon recovery failed", error);
        }
      }
      await this.codex.start();
      this.codexReconnectAttempt = 0;
    } catch (error) {
      this.#logError("Codex app-server start failed", error);
      this.#scheduleCodexReconnect();
    } finally {
      this.codexStarting = false;
    }
  }

  #scheduleCodexReconnect() {
    if (this.codexReconnectTimer || this.shuttingDown) return;
    const delay = Math.min(60_000, 2_000 * 2 ** Math.min(this.codexReconnectAttempt, 5));
    this.codexReconnectAttempt += 1;
    this.codexReconnectTimer = setTimeout(() => {
      this.codexReconnectTimer = null;
      this.#startCodex();
    }, delay);
    this.logger.warn("Scheduled Codex reconnect", { delayMs: delay });
  }

  #startLarkConsumer(eventKey) {
    try {
      this.lark.startConsumer(eventKey);
    } catch (error) {
      this.#logError("Lark event consumer start failed", error, { eventKey });
      this.#scheduleLarkReconnect(eventKey);
    }
  }

  #scheduleLarkReconnect(eventKey) {
    if (this.reconnectTimers.has(eventKey) || this.shuttingDown) return;
    const attempt = this.larkReconnectAttempts.get(eventKey) ?? 0;
    const delay = Math.min(60_000, 2_000 * 2 ** Math.min(attempt, 5));
    this.larkReconnectAttempts.set(eventKey, attempt + 1);
    const timer = setTimeout(() => {
      this.reconnectTimers.delete(eventKey);
      this.#startLarkConsumer(eventKey);
    }, delay);
    this.reconnectTimers.set(eventKey, timer);
    this.logger.warn("Scheduled Lark reconnect", { eventKey, delayMs: delay });
  }

  #logError(message, error, fields = {}) {
    this.logger.error(message, { ...fields, error: error?.message ?? String(error), stack: error?.stack });
  }
}

async function main() {
  try {
    enableDesktopDaemonEnvironment();
  } catch (error) {
    console.warn(`Codex Desktop shared app-server mode could not be enabled: ${error.message}`);
  }
  const config = await loadConfig();
  const bridge = new Bridge({ config });
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await bridge.stop();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  await bridge.start();
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((error) => {
    console.error(error?.stack ?? error);
    process.exit(1);
  });
}

export { VERSION, card, markdown };
