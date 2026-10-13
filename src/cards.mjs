import path from "node:path";
import { latestAgentMessage, latestTurn } from "./codex-client.mjs";
import { statusLabel, threadTitle, truncate } from "./commands.mjs";
import { VERSION } from "./version.mjs";
import { redact } from "./logger.mjs";

function plain(content) {
  return { tag: "plain_text", content };
}

function workspaceLabel(value) {
  return ["no-project", "FeishuTasks"].includes(value) ? "日常事项" : value;
}

function panel(title, elements, expanded = false) {
  return { tag: "collapsible_panel", expanded, background_color: "grey-50",
    border: { color: "grey-100", corner_radius: "8px" }, padding: "8px",
    header: { title: plain(title) }, elements };
}

function connectionHint(health) {
  if (!health) return "电脑需保持唤醒并联网。";
  const status = health.larkReady ? "飞书连接已确认" :
    health.larkConnectionState === "reconnecting" ? "飞书正在重连" : "飞书连接待确认";
  return `${status} · 最近收到消息：${timeLabel(health.lastMessageAt)}。这是最近状态，不保证电脑持续在线。`;
}

function callback(action, extra = {}) {
  return [{ type: "callback", value: { action, ts: Date.now(), ...extra } }];
}

function safeMarkdown(value = "") {
  return String(value).replaceAll("<", "&#60;").replaceAll(">", "&#62;");
}

function timeLabel(value) {
  if (!value) return "未知";
  const normalized = typeof value === "number" && value < 1_000_000_000_000 ? value * 1000 : value;
  const date = new Date(typeof normalized === "number" ? normalized : String(normalized));
  if (Number.isNaN(date.getTime())) return "未知";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false
  }).format(date);
}

function elapsedLabel(milliseconds) {
  if (milliseconds == null) return "未知";
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainingSeconds = seconds % 60;
  if (hours) return `${hours} 小时 ${minutes} 分`;
  if (minutes) return `${minutes} 分 ${remainingSeconds} 秒`;
  return `${remainingSeconds} 秒`;
}

function threadUpdatedAt(thread) {
  return thread.updatedAt ?? thread.updated_at ?? thread.rollout?.mtimeMs ?? null;
}

export function effectiveStatus(thread) {
  if (thread.rollout?.status === "inProgress") return { label: "运行中 · Desktop", color: "blue", template: "blue" };
  if (thread.rollout?.status === "completed") return { label: "已完成", color: "green", template: "green" };
  if (thread.rollout?.status === "interrupted") return { label: "已中断", color: "grey", template: "grey" };
  if (thread.rollout?.status === "failed") return { label: "执行失败", color: "red", template: "red" };
  if (thread.rollout?.status === "unknown") return { label: "状态未知", color: "grey", template: "grey" };
  const type = thread.status?.type ?? thread.status;
  if (type === "active" || type === "inProgress") return { label: "正在运行", color: "blue", template: "blue" };
  if (type === "completed" || (type === "idle" && latestTurn(thread)?.status === "completed")) return { label: "已完成", color: "green", template: "green" };
  if (type === "idle" && latestTurn(thread)?.status === "failed") return { label: "执行失败", color: "red", template: "red" };
  if (type === "idle" && latestTurn(thread)?.status === "interrupted") return { label: "已中断", color: "grey", template: "grey" };
  if (type === "idle") return { label: "暂无新结果", color: "neutral", template: "grey" };
  if (type === "failed" || type === "systemError") return { label: "执行失败", color: "red", template: "red" };
  if (type === "interrupted") return { label: "已中断", color: "grey", template: "grey" };
  return { label: statusLabel(type), color: "neutral", template: "grey" };
}

function baseCard({ title, subtitle, template = "blue", tag, elements, summary = title }) {
  return {
    schema: "2.0",
    config: {
      update_multi: true,
      width_mode: "default",
      enable_forward: false,
      summary: { content: summary },
      style: {
        text_size: {
          title: { default: "heading-3", pc: "heading-3", mobile: "heading-4" },
          body: { default: "normal", pc: "normal", mobile: "normal" },
          caption: { default: "notation", pc: "notation", mobile: "notation" }
        }
      }
    },
    header: {
      title: plain(title),
      subtitle: plain(subtitle),
      template,
      icon: { tag: "standard_icon", token: "myai_colorful" },
      ...(tag ? { text_tag_list: [{ tag: "text_tag", text: plain(tag.text), color: tag.color }] } : {})
    },
    body: {
      direction: "vertical",
      vertical_spacing: "12px",
      padding: "12px 12px 20px 12px",
      elements
    }
  };
}

function metricColumn(value, label, color = "blue") {
  return {
    tag: "column",
    width: "weighted",
    weight: 1,
    background_style: `${color}-50`,
    padding: "12px",
    vertical_spacing: "2px",
    elements: [
      { tag: "markdown", content: `## <font color='${color}'>${value}</font>`, text_align: "center" },
      { tag: "markdown", content: `<font color='grey'>${label}</font>`, text_align: "center", text_size: "caption" }
    ]
  };
}

function buttonColumn(text, action, extra, { primary = false, danger = false, confirm } = {}) {
  return {
    tag: "column",
    width: "weighted",
    weight: 1,
    elements: [{
      tag: "button",
      text: plain(text),
      type: danger ? (primary ? "danger_filled" : "danger") : primary ? "primary_filled" : "default",
      size: primary ? "large" : "medium",
      width: "fill",
      behaviors: callback(action, extra),
      ...(confirm ? { confirm: { title: plain(confirm.title), text: plain(confirm.text) } } : {})
    }]
  };
}

function actionRow(columns) {
  return { tag: "column_set", flex_mode: "none", horizontal_spacing: "8px", columns };
}

function taskBlock(thread, index, focusedThreadId = null) {
  const status = effectiveStatus(thread);
  const project = workspaceLabel(thread.cwd ? path.basename(thread.cwd) : "未知范围");
  const focused = thread.id === focusedThreadId;
  return {
    tag: "interactive_container",
    width: "fill",
    has_border: true,
    border_color: focused ? "blue-300" : `${status.color === "neutral" ? "grey" : status.color}-100`,
    corner_radius: "8px",
    background_style: `${status.color === "neutral" ? "grey" : status.color}-50`,
    padding: "12px",
    vertical_spacing: "4px",
    behaviors: callback("progress", { threadId: thread.id }),
    elements: [
      { tag: "markdown", content: `**${index + 1}. ${safeMarkdown(truncate(threadTitle(thread), 80))}**${focused ? "  <text_tag color='blue'>当前任务</text_tag>" : ""}` },
      { tag: "markdown", content: `<text_tag color='${status.color}'>${status.label}</text_tag>  <font color='grey'>${safeMarkdown(project)} · ${timeLabel(threadUpdatedAt(thread))}</font>`, text_size: "caption" }
    ]
  };
}

export function taskListCard(threads, { filter = null, focusedThreadId = null, queuedCount = 0, health = null } = {}) {
  const entries = threads.map((thread, index) => ({ thread, index, status: effectiveStatus(thread) }));
  const visible = entries.filter(({ status }) => filter === "active" ? status.label.includes("运行") :
    filter === "completed" ? status.label === "已完成" : true).slice(0, 5);
  const groups = [
    ["正在处理", visible.filter(({ status }) => status.label.includes("运行"))],
    ["需要我看看", visible.filter(({ status }) => ["执行失败", "已中断", "状态未知"].includes(status.label))],
    ["最近结果", visible.filter(({ status }) => !status.label.includes("运行") && !["执行失败", "已中断", "状态未知"].includes(status.label))]
  ];
  const taskElements = groups.flatMap(([label, items]) => items.length ? [
    { tag: "markdown", content: `**${label}**` },
    ...items.map(({ thread, index }) => taskBlock(thread, index, focusedThreadId))
  ] : []);
  const focused = threads.find((thread) => thread.id === focusedThreadId);
  return baseCard({
    title: "飞书工作助手",
    subtitle: "交办一件事，做好后在这里通知你",
    tag: { text: "首页", color: "blue" },
    elements: [
      ...(focused ? [{ tag: "markdown", content: `<font color='grey'>上次查看：${safeMarkdown(truncate(threadTitle(focused), 60))}。引用卡片或点“继续这件事”可接着处理。</font>` }] : []),
      actionRow([buttonColumn("交办新事项", "create_form", {}, { primary: true })]),
      panel("最近事项", taskElements.length ? taskElements : [{ tag: "markdown", content: "还没有事项。可以先让我整理一段文字、总结材料，或检查一个项目。" }], true),
      actionRow([
        buttonColumn("刷新", "home", {}),
        buttonColumn(queuedCount ? `待发送 ${queuedCount}` : "待发送", "queue", {})
      ]),
      panel("筛选与更多", [
        actionRow([buttonColumn("进行中", "home", { filter: "active" }), buttonColumn("已完成", "home", { filter: "completed" })]),
        actionRow([buttonColumn("全部事项", "home", {}), buttonColumn("定时事项", "schedule_list", {})]),
        actionRow([buttonColumn("使用帮助", "help", {}), buttonColumn("连接状态", "health", {})])
      ]),
      { tag: "markdown", content: `<font color='grey'>${safeMarkdown(connectionHint(health))}</font>`, text_size: "caption" }
    ],
    summary: `工作助手：${entries.filter(({ status }) => status.label.includes("运行")).length} 件正在处理`
  });
}

export function createTaskFormCard(workspaces, defaultWorkspace) {
  const options = Object.keys(workspaces).map((alias) => ({ text: plain(workspaceLabel(alias)), value: alias }));
  return baseCard({
    title: "交办新事项",
    subtitle: "选好处理范围，直接说要做什么",
    tag: { text: "新事项", color: "blue" },
    elements: [
      panel("可以从小事开始", [{ tag: "markdown", content: "整理一段文字、总结材料、润色回复，或跟进已有项目。涉及文档时请附上链接。" }], true),
      { tag: "form", name: "create_task_form", vertical_spacing: "12px", elements: [
        { tag: "select_static", name: "workspace", required: true, width: "fill", placeholder: plain("选择处理范围"), options, ...(defaultWorkspace ? { initial_option: defaultWorkspace } : {}) },
        { tag: "input", name: "prompt", required: true, input_type: "multiline_text", rows: 4, max_length: 1000, width: "fill", label: plain("要我帮你做什么？"), placeholder: plain("例如：把下面这段文字整理成三条待办……") },
        { tag: "button", name: "create_submit", form_action_type: "submit", text: plain("开始处理"), type: "primary_filled", size: "large", width: "fill" }
      ] },
      { tag: "markdown", content: "<font color='grey'>会在所选范围新建一件事。需要额外权限时，会提示你回电脑处理。</font>", text_size: "caption" },
      actionRow([buttonColumn("返回首页", "home", {})])
    ],
    summary: "交办新事项"
  });
}

export function progressCard(thread, { watching = false, queue = [] } = {}) {
  const status = effectiveStatus(thread);
  const progress = thread.rollout?.status === "completed" ?
    thread.rollout?.result || latestAgentMessage(thread) || thread.rollout?.progress :
    thread.rollout?.progress || thread.rollout?.result || latestAgentMessage(thread);
  const project = workspaceLabel(thread.cwd ? path.basename(thread.cwd) : "未知范围");
  const active = status.label.includes("运行");
  const completed = status.label === "已完成";
  const controls = [];
  if (!completed) controls.push(buttonColumn(watching ? "取消通知" : "完成时通知我", watching ? "unwatch" : "watch", { threadId: thread.id }));
  if (active) controls.push(buttonColumn("停止处理", "stop", { threadId: thread.id }, {
    danger: true, confirm: { title: "停止这件事？", text: "已经产生的文件修改不会自动撤销。" }
  }));
  else controls.push(buttonColumn("收起这件事", "archive", { threadId: thread.id }, {
    confirm: { title: "归档这件事？", text: "归档后仍可以通过任务 ID 找回。" }
  }));
  return baseCard({
    title: truncate(threadTitle(thread), 80),
    subtitle: `${project} · 更新于 ${timeLabel(threadUpdatedAt(thread))}`,
    template: status.template,
    tag: { text: status.label, color: status.color },
    elements: [
      panel(completed ? "最终结果" : "最近进展", [{ tag: "markdown", content: safeMarkdown(truncate(progress || (active ? "已收到，正在开始处理。" : "暂时没有可确认的结果。"), 600)) }], true),
      { tag: "markdown", content: queue.length ? `有 ${queue.length} 条补充等待发送，请勿重复提交。` :
        active ? (watching ? "完成或需要你处理时，会在这里通知。" : "可在下方更多操作中开启完成通知。") : "还要调整？点“继续这件事”，补充你的要求。" },
      actionRow([buttonColumn(active ? "补充说明" : "继续这件事", "send_form", { threadId: thread.id }, { primary: true })]),
      actionRow([
        buttonColumn("刷新", "progress", { threadId: thread.id }),
        buttonColumn("详细进展", "progress_detail", { threadId: thread.id })
      ]),
      panel("更多操作", [
        actionRow([buttonColumn("查看待发送", "queue", {})]),
        actionRow(controls)
      ]),
      ...(progress?.length > 600 ? [panel("展开更多内容", [{ tag: "markdown", content: safeMarkdown(truncate(progress, 1800)) }])] : []),
      actionRow([buttonColumn("返回首页", "home", {})])
    ],
    summary: `${threadTitle(thread)}：${status.label}`
  });
}

function detailStatusColor(status) {
  if (status === "completed") return "green";
  if (status === "failed") return "red";
  if (status === "declined" || status === "interrupted") return "grey";
  if (status === "inProgress") return "blue";
  return "neutral";
}

function planMarkdown(detail) {
  if (detail.plan?.length) {
    return detail.plan.map((entry) => {
      const marker = entry.status === "completed" ? "✅" : entry.status === "inProgress" ? "➡️" : "○";
      const suffix = entry.status === "inProgress" ? "  <text_tag color='blue'>进行中</text_tag>" : "";
      return `${marker} ${safeMarkdown(entry.step)}${suffix}`;
    }).join("\n");
  }
  return safeMarkdown(detail.planText || "任务尚未上报结构化执行计划。");
}

function activityMarkdown(activities) {
  if (!activities?.length) return "<font color='grey'>当前回合尚未产生可展示的执行记录。</font>";
  return activities.map((activity) => {
    const color = detailStatusColor(activity.status);
    const timestamp = activity.updatedAt ? `<font color='grey'>${timeLabel(activity.updatedAt)}</font>  ` : "";
    const duration = activity.durationMs == null ? "" : ` · ${elapsedLabel(activity.durationMs)}`;
    const meta = activity.meta ? ` · ${safeMarkdown(activity.meta)}` : "";
    const detail = activity.detail ? `\n<font color='grey'>${safeMarkdown(activity.detail)}</font>` : "";
    const error = activity.error ? `\n<font color='red'>${safeMarkdown(activity.error)}</font>` : "";
    return `${timestamp}<text_tag color='${color}'>${safeMarkdown(activity.category)}</text_tag> **${safeMarkdown(activity.label)}**  <font color='grey'>${safeMarkdown(activity.statusLabel)}${duration}${meta}</font>${detail}${error}`;
  }).join("\n\n");
}

function filesMarkdown(files) {
  if (!files?.length) return "<font color='grey'>本轮暂未记录文件修改。</font>";
  const kindLabels = { add: "新增", delete: "删除", update: "修改", move: "移动" };
  return files.slice(0, 12).map((file) => {
    const label = kindLabels[file.kind] ?? "修改";
    return `- <text_tag color='${file.kind === "delete" ? "red" : file.kind === "add" ? "green" : "blue"}'>${label}</text_tag> ${safeMarkdown(file.path)}`;
  }).join("\n");
}

export function progressDetailCard(thread, detail, { queue = [] } = {}) {
  const status = effectiveStatus(thread);
  const active = detail.status === "inProgress" || status.label.includes("运行");
  const planMetric = detail.planTotal ? `${detail.planCompleted}/${detail.planTotal}` : "—";
  const pageLabel = detail.page?.isHistorical ? "较早记录" : "最新记录";
  const historyButtons = [];
  if (detail.page?.nextCursor) historyButtons.push(buttonColumn("更早记录", "progress_detail", {
    threadId: thread.id, turnId: detail.turnId, cursor: detail.page.nextCursor
  }));
  const management = active ? buttonColumn("停止处理", "stop", { threadId: thread.id }, {
    danger: true, confirm: { title: "停止当前事项？", text: "已经产生的文件修改不会自动撤销。" }
  }) : buttonColumn("收起这件事", "archive", { threadId: thread.id }, {
    confirm: { title: "归档这件事？", text: "归档后仍可通过任务 ID 找回。" }
  });

  return baseCard({
    title: truncate(threadTitle(thread), 80),
    subtitle: `${path.basename(thread.cwd ?? "未知项目")} · ${pageLabel} · ${timeLabel(detail.updatedAt ?? Date.now())}`,
    template: detail.attention || detail.error ? "yellow" : status.template,
    tag: { text: `详细进展 · ${detail.statusLabel}`, color: detailStatusColor(detail.status) },
    elements: [
      {
        tag: "column_set", flex_mode: "none", columns: [{
          tag: "column", width: "weighted", weight: 1,
          background_style: `${detail.attention || detail.error ? "yellow" : status.template}-50`, padding: "12px", vertical_spacing: "4px",
          elements: [
            { tag: "markdown", content: `**当前阶段**\n${safeMarkdown(detail.currentStage)}` },
            { tag: "markdown", content: `<font color='grey'>已运行 ${elapsedLabel(detail.durationMs)} · 本轮 ${safeMarkdown(detail.turnId?.slice(0, 8) ?? "无")}</font>`, text_size: "caption" }
          ]
        }]
      },
      {
        tag: "column_set", flex_mode: "none", horizontal_spacing: "8px", columns: [
          metricColumn(planMetric, "计划", "blue"),
          metricColumn(detail.stats.tools, "工具调用", "violet"),
          metricColumn(detail.stats.commands, "命令", "blue"),
          metricColumn(detail.stats.files, "文件", "green")
        ]
      },
      {
        tag: "collapsible_panel", expanded: true, background_color: "blue-50",
        border: { color: "blue-100", corner_radius: "8px" }, padding: "8px", vertical_spacing: "8px",
        header: { title: plain(detail.planTotal ? `执行计划 ${detail.planCompleted}/${detail.planTotal}` : "执行计划") },
        elements: [
          ...(detail.planExplanation ? [{ tag: "markdown", content: `<font color='grey'>${safeMarkdown(detail.planExplanation)}</font>` }] : []),
          { tag: "markdown", content: planMarkdown(detail) }
        ]
      },
      {
        tag: "collapsible_panel", expanded: true, background_color: "grey-50",
        border: { color: "grey-100", corner_radius: "8px" }, padding: "8px", vertical_spacing: "8px",
        header: { title: plain(`最近活动 · ${pageLabel}`) },
        elements: [{ tag: "markdown", content: activityMarkdown(detail.activities) }]
      },
      {
        tag: "collapsible_panel", expanded: detail.stats.files > 0 || detail.stats.errors > 0, background_color: "grey-50",
        border: { color: "grey-100", corner_radius: "8px" }, padding: "8px", vertical_spacing: "8px",
        header: { title: plain(`文件与异常 · ${detail.stats.files} 个文件 / ${detail.stats.errors} 个异常`) },
        elements: [
          { tag: "markdown", content: filesMarkdown(detail.files) },
          ...(detail.error ? [{ tag: "markdown", content: `<font color='red'>${safeMarkdown(detail.error)}</font>` }] : [])
        ]
      },
      actionRow([buttonColumn(detail.page?.isHistorical ? "回到最新进展" : "刷新进展", "progress_detail", { threadId: thread.id, turnId: detail.turnId }, { primary: true })]),
      actionRow([buttonColumn(active ? "补充说明" : "继续这件事", "send_form", { threadId: thread.id }), ...historyButtons]),
      panel("更多操作", [actionRow([management])]),
      actionRow([buttonColumn("返回事项摘要", "progress", { threadId: thread.id }), buttonColumn("返回首页", "home", {})])
    ],
    summary: `${threadTitle(thread)}：${detail.currentStage}`
  });
}

export function sendMessageFormCard(thread) {
  return baseCard({
    title: "继续这件事",
    subtitle: truncate(threadTitle(thread), 80),
    tag: { text: "补充说明", color: "blue" },
    elements: [
      { tag: "markdown", content: `处理范围：${safeMarkdown(workspaceLabel(path.basename(thread.cwd ?? "未知范围")))}。下方补充只发给这件事。` },
      { tag: "form", name: "send_message_form", vertical_spacing: "12px", elements: [
        { tag: "select_static", name: "target_thread", required: true, width: "fill", initial_option: thread.id, options: [{ text: plain(truncate(threadTitle(thread), 80)), value: thread.id }] },
        { tag: "input", name: "message", required: true, input_type: "multiline_text", rows: 4, max_length: 1000, width: "fill", label: plain("补充什么？"), placeholder: plain("补充要求、回答问题或要求继续处理") },
        { tag: "button", name: "send_submit", form_action_type: "submit", text: plain("发送到这件事"), type: "primary_filled", size: "large", width: "fill" }
      ] },
      { tag: "markdown", content: "<font color='grey'>要补充图片？请在飞书聊天窗口直接发图，再确认“继续这件事”；也可以引用回复对应事项卡发送图片。</font>", text_size: "caption" },
      actionRow([
        buttonColumn("返回事项摘要", "progress", { threadId: thread.id }),
        buttonColumn("返回首页", "home", {})
      ])
    ],
    summary: `继续任务：${threadTitle(thread)}`
  });
}

export function completionCard(thread, turnStatus, result = "") {
  const completed = turnStatus === "completed";
  const status = completed ? { label: "已完成", template: "green", color: "green" } : effectiveStatus({ status: turnStatus });
  const finalResult = result || thread.rollout?.result || latestAgentMessage(thread) || "任务已结束，未提供最终摘要。";
  return baseCard({
    title: completed ? "这件事已完成" : `Codex 任务${statusLabel(turnStatus)}`,
    subtitle: truncate(threadTitle(thread), 80),
    template: status.template,
    tag: { text: status.label, color: status.color },
    elements: [
      {
        tag: "column_set", flex_mode: "none", columns: [{
          tag: "column", width: "weighted", weight: 1, background_style: `${status.template}-50`, padding: "12px",
          elements: [{ tag: "markdown", content: `**<font color='${status.template}'>${completed ? "任务已完成" : status.label}</font>**\n<font color='grey'>${safeMarkdown(workspaceLabel(path.basename(thread.cwd ?? "未知范围")))} · ${timeLabel(Date.now())}</font>` }]
        }]
      },
      {
        tag: "collapsible_panel", expanded: true, background_color: "grey-50", border: { color: "grey-100", corner_radius: "8px" }, padding: "8px",
        header: { title: plain("结果摘要") }, elements: [{ tag: "markdown", content: safeMarkdown(truncate(finalResult, 600)) }]
      },
      actionRow([buttonColumn("继续这件事", "send_form", { threadId: thread.id }, { primary: true })]),
      actionRow([
        buttonColumn("查看结果", "progress", { threadId: thread.id }),
        buttonColumn("交办新事项", "create_form", {})
      ]),
      ...(finalResult.length > 600 ? [panel("展开更多结果", [{ tag: "markdown", content: safeMarkdown(truncate(finalResult, 2200)) }])] : []),
      actionRow([buttonColumn("返回首页", "home", {})])
    ],
    summary: `${threadTitle(thread)}：${status.label}`
  });
}

export function healthCard(health) {
  const ok = health.codexReady && health.larkReady && !health.pendingDeliveryCount &&
    !health.uncertainDeliveryCount && !health.uncertainSubmissionCount;
  const recovering = !health.codexReady && health.codexRecovery?.recovering;
  const codexStatus = health.codexReady ? "已连接" : recovering ? "修复中" : "断开";
  const recoveryStatus = health.codexReady ? "官方服务已连接" :
    recovering ? "正在自动拉起官方服务" :
    health.codexRecovery?.lastError ? `等待重试：${truncate(health.codexRecovery.lastError, 200)}` :
    health.codexRecovery?.enabled ? "等待下一次自动恢复" : "自动恢复未启用";
  return baseCard({
    title: "连接与待处理",
    subtitle: `v${health.version} · 运行 ${health.uptime}`,
    template: ok ? "green" : "yellow",
    tag: { text: ok ? "运行正常" : "需要关注", color: ok ? "green" : "yellow" },
    elements: [
      { tag: "column_set", flex_mode: "none", horizontal_spacing: "8px", columns: [
        metricColumn(codexStatus, "Codex", health.codexReady ? "green" : recovering ? "yellow" : "red"),
        metricColumn(health.larkReady ? "已连接" : health.larkConnectionState === "reconnecting" ? "重连中" : "待确认", "飞书", health.larkReady ? "green" : "yellow"),
        metricColumn(health.queuedCount, "等待处理", "violet")
      ] },
      { tag: "markdown", content: connectionHint(health) },
      panel("连接与排查详情", [{ tag: "div", fields: [
        { is_short: true, text: { tag: "lark_md", content: `**最近消息**\n${timeLabel(health.lastMessageAt)}` } },
        { is_short: true, text: { tag: "lark_md", content: `**最近回复**\n${timeLabel(health.lastReplyAt)}` } },
        { is_short: true, text: { tag: "lark_md", content: `**关注任务**\n${health.watchCount}` } },
        { is_short: true, text: { tag: "lark_md", content: `**自动恢复**\n${safeMarkdown(recoveryStatus)}` } },
        { is_short: true, text: { tag: "lark_md", content: `**回复待补发**\n${health.pendingDeliveryCount ?? 0}` } },
        { is_short: true, text: { tag: "lark_md", content: `**回复待核对**\n${health.uncertainDeliveryCount ?? 0}` } },
        { is_short: true, text: { tag: "lark_md", content: `**提交待核对**\n${health.uncertainSubmissionCount ?? 0}` } },
        { is_short: false, text: { tag: "lark_md", content: `**最近错误**\n${safeMarkdown(redact(health.lastError ?? "无"))}` } }
      ] }]),
      actionRow([buttonColumn("刷新连接状态", "health", {}, { primary: true })]),
      actionRow([buttonColumn("查看待处理消息", "queue", {})]),
      actionRow([buttonColumn("返回首页", "home", {})])
    ],
    summary: `Codex 助手：${ok ? "运行正常" : "需要关注"}`
  });
}

export function queueCard(items, titleLookup = new Map(), operations = []) {
  const grouped = new Map();
  for (const item of items) {
    if (!grouped.has(item.threadId)) grouped.set(item.threadId, []);
    grouped.get(item.threadId).push(item);
  }
  const priorityThread = items.find((item) => item.submissionUncertain)?.threadId ??
    [...grouped].find(([, messages]) => messages[0].dispatchPaused)?.[0] ?? null;
  const groups = [...grouped].map(([threadId, messages]) => {
    const title = titleLookup.get(threadId) ?? threadId.slice(0, 8);
    const head = messages[0];
    const uncertain = messages.some((item) => item.submissionUncertain);
    const content = messages.map((item, index) => {
      const status = item.submissionUncertain ? "正在确认是否已执行，请勿重复发送。" :
        item.dispatchPaused ? "暂未发送成功，已暂停重试。" : item.lastError ? "暂未发送成功，正在自动重试，无需重发。" : "已保存，等待当前事项处理完。";
      return `**补充 ${index + 1}** ${safeMarkdown(truncate(item.text, 180))}\n${status}`;
    }).join("\n\n");
    const main = threadId === priorityThread;
    const controls = uncertain ? [buttonColumn("查看这件事", "progress", { threadId }, { primary: main })] : [
      ...(head.dispatchPaused ? [buttonColumn("重试第一条", "queue_retry", { threadId }, { primary: main, confirm: { title: `重试：${truncate(title, 40)}`, text: "如果你已手动发送，请先取消旧消息，避免重复执行。" } })] : []),
      buttonColumn("取消待发送", "queue_cancel", { threadId }, { confirm: { title: `取消：${truncate(title, 40)}`, text: `取消这件事的 ${messages.length} 条待发送补充，不停止正在处理的事项。` } })
    ];
    return panel(title, [{ tag: "markdown", content },
      ...(main && controls.length > 1 ? [actionRow([controls[0]]), actionRow(controls.slice(1))] : [actionRow(controls)])
    ], true);
  });
  const operationContent = operations.map((item, index) => {
    const label = item.type === "create" ? "新事项" : "补充说明";
    const status = item.status === "uncertain" ? "正在确认是否已执行，请勿重复发送。" :
      item.status === "failed" ? "自动恢复未成功，请打开连接状态查看原因。" : "电脑恢复连接后会继续处理，无需重发。";
    return `**${index + 1}. ${label} · ${safeMarkdown(workspaceLabel(item.workspace ?? item.threadId?.slice(0, 8) ?? "未知范围"))}**\n${safeMarkdown(truncate(item.text, 180))}\n${status}`;
  }).join("\n\n");
  const errors = [...items, ...operations].filter((item) => item.lastError).map((item) => safeMarkdown(truncate(redact(item.lastError), 250)));
  const total = items.length + operations.length;
  return baseCard({
    title: "待发送与恢复",
    subtitle: total ? `${total} 条消息已保留` : "目前没有待发送消息",
    tag: { text: total ? "等待处理" : "已清空", color: total ? "yellow" : "neutral" },
    template: total ? "yellow" : "grey",
    elements: [
      ...(groups.length ? groups : [panel("等待发送的补充", [{ tag: "markdown", content: "没有等待发送的补充。" }], true)]),
      ...(operationContent ? [panel("等待电脑恢复", [{ tag: "markdown", content: operationContent }], true)] : []),
      actionRow([buttonColumn("刷新状态", "queue", {}, { primary: !priorityThread })]),
      actionRow([buttonColumn("连接状态", "health", {})]),
      ...(errors.length ? [panel("技术详情", [{ tag: "markdown", content: errors.join("\n\n") }])] : []),
      actionRow([buttonColumn("返回首页", "home", {})])
    ]
  });
}

export function stopConfirmCard(thread) {
  return baseCard({
    title: "确认停止这件事",
    subtitle: truncate(threadTitle(thread), 80),
    template: "red",
    tag: { text: "危险操作", color: "red" },
    elements: [
      { tag: "column_set", flex_mode: "none", columns: [{ tag: "column", width: "weighted", weight: 1, background_style: "red-50", padding: "12px", elements: [{ tag: "markdown", content: "**停止后不会自动撤销已经产生的文件修改。**\n请确认是否中断当前回合。" }] }] },
      actionRow([
        buttonColumn("确认停止", "stop", { threadId: thread.id }, { primary: true, danger: true, confirm: { title: "再次确认", text: "确定停止当前 Codex 回合？" } })
      ]),
      actionRow([buttonColumn("继续等待，返回事项", "progress", { threadId: thread.id })
      ])
    ]
  });
}

export function noticeCard({ title, message, template = "blue", status = "提示", action = { text: "返回首页", action: "home" }, details = null }) {
  return baseCard({
    title,
    subtitle: timeLabel(Date.now()),
    template,
    tag: { text: status, color: template === "grey" ? "neutral" : template },
    elements: [
      { tag: "column_set", flex_mode: "none", columns: [{ tag: "column", width: "weighted", weight: 1, background_style: `${template}-50`, padding: "12px", elements: [{ tag: "markdown", content: safeMarkdown(message) }] }] },
      ...(action ? [actionRow([buttonColumn(action.text, action.action, action.value ?? {}, { primary: true })])] : []),
      ...(details ? [panel("技术详情", [{ tag: "markdown", content: safeMarkdown(truncate(redact(details), 500)) }])] : [])
    ],
    summary: `${title}：${truncate(message, 80)}`
  });
}

export function helpCard() {
  return baseCard({
    title: "飞书工作助手",
    subtitle: `交办、查看、接着处理 · 公开 Beta v${VERSION}`,
    tag: { text: "使用帮助", color: "blue" },
    elements: [
      panel("三步就够了", [{ tag: "markdown", content: "**1. 交办一件事**\n直接描述需求，或点“交办新事项”选择范围。\n\n**2. 等这里的结果**\n完成或需要处理时会通知你，可以随时查看进展。\n\n**3. 接着处理**\n点结果卡上的“继续这件事”，在表单里补充要求；也可以引用回复原卡片。目标不清楚时，会先请你选择。" }], true),
      actionRow([buttonColumn("交办新事项", "create_form", {}, { primary: true })]),
      panel("附件、定时与快捷指令", [{ tag: "markdown", content: "图片、文件可以直接发送；短语音需开通转写权限。\n定时示例：`定时 每天 09:00 no-project 整理今天的待办`。\n快捷指令仍可用：`任务`、`新建 项目 内容`、`继续1 内容`、`进度1`、`队列`、`健康`、`定时任务`、`静默 2小时`。" }]),
      { tag: "markdown", content: "<font color='grey'>任务在你的电脑上运行，电脑需保持唤醒并联网。需要额外权限时，请回 Codex 处理。</font>", text_size: "caption" },
      actionRow([buttonColumn("返回首页", "home", {})])
    ],
    summary: "交办一件事，做好后在飞书通知你"
  });
}

export function clarificationCard(pending, currentThread, workspace) {
  return baseCard({
    title: "确认这条消息要发到哪里",
    subtitle: "原消息已保留，还没有发送",
    template: "yellow",
    tag: { text: "需要确认", color: "yellow" },
    elements: [
      {
        tag: "column_set", flex_mode: "none", columns: [{
          tag: "column", width: "weighted", weight: 1, background_style: "yellow-50", padding: "12px", vertical_spacing: "4px",
          elements: [
            { tag: "markdown", content: `**${safeMarkdown(truncate(pending.message, 300))}**` },
            { tag: "markdown", content: `<font color='grey'>继续处理：${safeMarkdown(truncate(threadTitle(currentThread), 80))}\n所属范围：${safeMarkdown(workspaceLabel(path.basename(currentThread.cwd ?? "未知范围")))}\n另开一件事的范围：${safeMarkdown(workspaceLabel(workspace))}</font>`, text_size: "caption" }
          ]
        }]
      },
      actionRow([buttonColumn("继续这件事", "clarify_continue", { pendingId: pending.id }, { primary: true })]),
      actionRow([buttonColumn("另开一件事", "clarify_create", { pendingId: pending.id }), buttonColumn("取消这条消息", "clarify_cancel", { pendingId: pending.id })])
    ],
    summary: "请选择继续当前任务或新建任务"
  });
}

function scheduleStatus(schedule) {
  if (schedule.status === "paused") return { label: "已暂停", color: "yellow" };
  if (schedule.status === "queued") return { label: "等待执行", color: "violet" };
  if (schedule.status === "completed") return { label: "已完成", color: "green" };
  if (schedule.status === "missed") return { label: "已错过", color: "red" };
  if (schedule.status === "failed") return { label: "执行失败", color: "red" };
  if (schedule.status === "canceled") return { label: "已取消", color: "neutral" };
  return { label: "已启用", color: "blue" };
}

function scheduleBlock(schedule, index) {
  const status = scheduleStatus(schedule);
  return {
    tag: "interactive_container",
    width: "fill",
    has_border: true,
    border_color: `${status.color === "neutral" ? "grey" : status.color}-100`,
    corner_radius: "8px",
    background_style: `${status.color === "neutral" ? "grey" : status.color}-50`,
    padding: "12px",
    vertical_spacing: "4px",
    behaviors: callback("schedule_detail", { scheduleId: schedule.id }),
    elements: [
      { tag: "markdown", content: `**${index + 1}. ${safeMarkdown(truncate(schedule.prompt, 90))}**` },
      { tag: "markdown", content: `<text_tag color='${status.color}'>${status.label}</text_tag>  <font color='grey'>${safeMarkdown(schedule.label)} · ${safeMarkdown(workspaceLabel(schedule.workspace))}</font>`, text_size: "caption" }
    ]
  };
}

export function scheduleListCard(schedules) {
  const active = schedules.filter((schedule) => schedule.status === "active").length;
  return baseCard({
    title: "定时事项",
    subtitle: `${active} 项已启用 · 按本机时区执行`,
    tag: { text: "定时", color: "blue" },
    elements: [
      panel("最近计划", schedules.length ? schedules.slice(0, 8).map(scheduleBlock) : [{ tag: "markdown", content: "还没有定时事项。可以安排每天固定时间整理待办，或在指定时间处理一件事。" }], true),
      actionRow([buttonColumn("新增定时事项", "schedule_form", {}, { primary: true })]),
      actionRow([buttonColumn("刷新列表", "schedule_list", {})]),
      { tag: "markdown", content: "<font color='grey'>到时间时，电脑需要保持唤醒并联网。</font>", text_size: "caption" },
      actionRow([buttonColumn("返回首页", "home", {})])
    ],
    summary: `定时事项：${active} 项已启用`
  });
}

export function scheduleCreateFormCard(defaultWorkspace) {
  return baseCard({
    title: "新增定时事项",
    subtitle: `默认范围：${workspaceLabel(defaultWorkspace)}`,
    tag: { text: "新计划", color: "blue" },
    elements: [
      panel("先确定时间和要做的事", [{ tag: "markdown", content: "例如：每天 09:00 整理今天的待办。\n也可以写：明天 10:30 总结这份文档，并附上文档链接。" }], true),
      { tag: "form", name: "schedule_create_form", vertical_spacing: "12px", elements: [
        { tag: "input", name: "expression", required: true, input_type: "multiline_text", rows: 4, max_length: 1000, width: "fill", label: plain("什么时候，要做什么？"), placeholder: plain("每天 09:00 ……") },
        { tag: "button", name: "schedule_submit", form_action_type: "submit", text: plain("保存这项计划"), type: "primary_filled", size: "large", width: "fill" }
      ] },
      actionRow([buttonColumn("返回定时列表", "schedule_list", {})])
    ],
    summary: "新增定时事项"
  });
}

export function scheduleDetailCard(schedule) {
  const status = scheduleStatus(schedule);
  const primary = schedule.status === "active" ? buttonColumn("暂停这项计划", "schedule_pause", { scheduleId: schedule.id }, { primary: true }) :
    schedule.status === "paused" ? buttonColumn("恢复这项计划", "schedule_resume", { scheduleId: schedule.id }, { primary: true }) :
    schedule.lastThreadId ? buttonColumn("查看最近结果", "progress", { threadId: schedule.lastThreadId }, { primary: true }) :
    buttonColumn("刷新计划状态", "schedule_detail", { scheduleId: schedule.id }, { primary: true });
  const cancel = ["active", "paused", "queued", "failed", "missed"].includes(schedule.status) ? buttonColumn("取消这项计划", "schedule_cancel", { scheduleId: schedule.id }, {
    danger: true, confirm: { title: "取消这项计划？", text: "不会停止已经开始执行的事项。" }
  }) : null;
  return baseCard({
    title: "定时事项详情",
    subtitle: truncate(schedule.prompt, 80),
    template: status.color === "neutral" ? "grey" : status.color,
    tag: { text: status.label, color: status.color },
    elements: [
      { tag: "div", fields: [
        { is_short: true, text: { tag: "lark_md", content: `**计划**\n${safeMarkdown(schedule.label)}` } },
        { is_short: true, text: { tag: "lark_md", content: `**项目**\n${safeMarkdown(workspaceLabel(schedule.workspace))}` } },
        { is_short: true, text: { tag: "lark_md", content: `**下次执行**\n${timeLabel(schedule.nextRunAt)}` } },
        { is_short: true, text: { tag: "lark_md", content: `**最近任务**\n${schedule.lastThreadId?.slice(0, 8) ?? "无"}` } }
      ] },
      { tag: "column_set", flex_mode: "none", columns: [{ tag: "column", width: "weighted", weight: 1, background_style: `${status.color === "neutral" ? "grey" : status.color}-50`, padding: "12px", elements: [{ tag: "markdown", content: `**任务内容**\n${safeMarkdown(truncate(schedule.prompt, 1000))}` }] }] },
      actionRow([primary]),
      ...(cancel ? [panel("更多操作", [actionRow([cancel])])] : []),
      actionRow([buttonColumn("返回定时列表", "schedule_list", {})])
    ],
    summary: `${schedule.prompt}：${status.label}`
  });
}

export function parseActionValue(raw) {
  if (!raw) return {};
  if (typeof raw === "object") return raw;
  try { return JSON.parse(raw); } catch { return { action: raw }; }
}
