import path from "node:path";
import { latestAgentMessage, latestTurn } from "./codex-client.mjs";
import { statusLabel, threadTitle, truncate } from "./commands.mjs";

function plain(content) {
  return { tag: "plain_text", content };
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
  const type = thread.status?.type ?? thread.status;
  if (type === "active" || type === "inProgress") return { label: "正在运行", color: "blue", template: "blue" };
  if (type === "completed" || type === "idle") return { label: "已完成", color: "green", template: "green" };
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

function buttonColumn(text, action, extra, { primary = false, danger = false, disabled = false, confirm } = {}) {
  return {
    tag: "column",
    width: "weighted",
    weight: 1,
    elements: [{
      tag: "button",
      text: plain(text),
      type: danger ? "danger" : primary ? "primary_filled" : "default",
      width: "fill",
      behaviors: callback(action, extra),
      ...(disabled ? { disabled: true } : {}),
      ...(confirm ? { confirm: { title: plain(confirm.title), text: plain(confirm.text) } } : {})
    }]
  };
}

function actionRow(columns) {
  return { tag: "column_set", flex_mode: "none", horizontal_spacing: "8px", columns };
}

function pageIndicatorColumn(page, pageCount) {
  return {
    tag: "column",
    width: "weighted",
    weight: 1,
    vertical_align: "center",
    elements: [{ tag: "markdown", content: `**${page + 1} / ${pageCount}**`, text_align: "center", text_size: "caption" }]
  };
}

function taskBlock(thread, index, focusedThreadId = null) {
  const status = effectiveStatus(thread);
  const project = thread.cwd ? path.basename(thread.cwd) : "未知项目";
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

export function taskListCard(threads, { queuedCount = 0, filter = null, focusedThreadId = null, page = 0 } = {}) {
  const activeCount = threads.filter((thread) => effectiveStatus(thread).label.includes("运行")).length;
  const completedCount = threads.filter((thread) => effectiveStatus(thread).label === "已完成").length;
  const visible = filter === "active" ? threads.filter((thread) => effectiveStatus(thread).label.includes("运行")) :
    filter === "completed" ? threads.filter((thread) => effectiveStatus(thread).label === "已完成") : threads;
  const limited = visible.slice(0, 10);
  const pageSize = 3;
  const pageCount = Math.max(1, Math.ceil(limited.length / pageSize));
  const requestedPage = Number.isInteger(page) ? page : 0;
  const currentPage = Math.min(Math.max(requestedPage, 0), pageCount - 1);
  const offset = currentPage * pageSize;
  const taskElements = limited.length > 0 ? limited.slice(offset, offset + pageSize).map((thread, index) => taskBlock(thread, offset + index, focusedThreadId)) : [
    { tag: "markdown", content: "<font color='grey'>当前没有符合条件的任务。</font>" }
  ];
  const rangeStart = limited.length > 0 ? offset + 1 : 0;
  const rangeEnd = Math.min(offset + pageSize, limited.length);
  const listTitle = filter === "active" ? "正在运行" : filter === "completed" ? "最近完成" : "最近任务";
  const pager = pageCount > 1 ? actionRow([
    buttonColumn("上一页", "home", { filter, page: currentPage - 1 }, { disabled: currentPage === 0 }),
    pageIndicatorColumn(currentPage, pageCount),
    buttonColumn("下一页", "home", { filter, page: currentPage + 1 }, { primary: currentPage < pageCount - 1, disabled: currentPage === pageCount - 1 })
  ]) : null;
  return baseCard({
    title: "Codex 任务",
    subtitle: `个人远程控制台 · ${timeLabel(Date.now())}`,
    tag: { text: filter === "active" ? "进行中" : filter === "completed" ? "已完成" : "首页", color: "blue" },
    elements: [
      {
        tag: "column_set",
        flex_mode: "none",
        horizontal_spacing: "8px",
        columns: [metricColumn(activeCount, "运行中"), metricColumn(completedCount, "已完成", "green"), metricColumn(queuedCount, "排队消息", "violet")]
      },
      {
        tag: "collapsible_panel",
        expanded: true,
        background_color: "grey-50",
        border: { color: "grey-100", corner_radius: "8px" },
        padding: "8px",
        vertical_spacing: "8px",
        header: { title: plain(`${listTitle} · ${rangeStart}–${rangeEnd} / ${limited.length}`) },
        elements: taskElements
      },
      ...(pager ? [pager] : []),
      actionRow([
        buttonColumn("刷新", "home", { filter, page: currentPage }, { primary: true }),
        buttonColumn("新建任务", "create_form", {})
      ]),
      actionRow([
        buttonColumn("进行中", "home", { filter: "active" }),
        buttonColumn("已完成", "home", { filter: "completed" }),
        buttonColumn("消息队列", "queue", {})
      ])
    ],
    summary: `Codex 任务：${activeCount} 个运行中`
  });
}

export function createTaskFormCard(workspaces, defaultWorkspace) {
  const options = Object.keys(workspaces).map((alias) => ({ text: plain(alias), value: alias }));
  return baseCard({
    title: "新建 Codex 任务",
    subtitle: "选择项目并描述要完成的工作",
    tag: { text: "新任务", color: "blue" },
    elements: [
      {
        tag: "column_set",
        flex_mode: "none",
        columns: [{
          tag: "column", width: "weighted", weight: 1,
          background_style: "blue-50", padding: "12px", vertical_spacing: "4px",
          elements: [{ tag: "markdown", content: "**任务会在所选项目目录中创建**\n<font color='grey'>需要额外权限时只通知你回 Codex Desktop 处理。</font>" }]
        }]
      },
      {
        tag: "form",
        name: "create_task_form",
        vertical_spacing: "12px",
        elements: [
          { tag: "markdown", content: "**项目**" },
          { tag: "select_static", name: "workspace", required: true, width: "fill", placeholder: plain("请选择项目"), options, ...(defaultWorkspace ? { initial_option: defaultWorkspace } : {}) },
          { tag: "input", name: "prompt", required: true, input_type: "multiline_text", rows: 6, max_length: 1000, width: "fill", label: plain("任务需求"), placeholder: plain("说明目标、范围和验收要求") },
          { tag: "markdown", content: "**推理强度**" },
          { tag: "select_static", name: "effort", required: true, width: "fill", initial_option: "default", options: [
            { text: plain("使用 Codex 默认设置"), value: "default" },
            { text: plain("Medium"), value: "medium" },
            { text: plain("High"), value: "high" },
            { text: plain("XHigh"), value: "xhigh" },
            { text: plain("Ultra"), value: "ultra" }
          ] },
          { tag: "button", name: "create_submit", form_action_type: "submit", text: plain("创建并开始"), type: "primary_filled", width: "fill" }
        ]
      }
    ],
    summary: "新建 Codex 任务"
  });
}

export function progressCard(thread, { watching = false, queue = [] } = {}) {
  const status = effectiveStatus(thread);
  const turn = latestTurn(thread);
  const progress = thread.rollout?.progress || thread.rollout?.result || latestAgentMessage(thread) || "尚未产生可展示的进展。";
  const project = thread.cwd ? path.basename(thread.cwd) : "未知";
  const active = status.label.includes("运行");
  const buttons = [
    buttonColumn("刷新", "progress", { threadId: thread.id }, { primary: true }),
    buttonColumn("详细进展", "progress_detail", { threadId: thread.id }),
    buttonColumn("继续任务", "send_form", { threadId: thread.id })
  ];
  const managementButtons = [
    buttonColumn(watching ? "取消关注" : "关注完成", watching ? "unwatch" : "watch", { threadId: thread.id }),
    buttonColumn("返回任务列表", "home", {})
  ];
  if (active) managementButtons.push(buttonColumn("停止", "stop", { threadId: thread.id }, {
      danger: true,
      confirm: { title: "停止当前回合？", text: "已经产生的文件修改不会自动撤销。" }
    }));
  else managementButtons.push(buttonColumn("归档", "archive", { threadId: thread.id }, {
    confirm: { title: "归档任务？", text: "归档后可以通过任务 ID 恢复。" }
  }));
  return baseCard({
    title: truncate(threadTitle(thread), 80),
    subtitle: `${project} · 更新于 ${timeLabel(threadUpdatedAt(thread))}`,
    template: status.template,
    tag: { text: status.label, color: status.color },
    elements: [
      {
        tag: "column_set", flex_mode: "none", columns: [{
          tag: "column", width: "weighted", weight: 1,
          background_style: `${status.template}-50`, padding: "12px", vertical_spacing: "4px",
          elements: [{ tag: "markdown", content: `**<font color='${status.template}'>${status.label}</font>**\n<font color='grey'>${active ? "Codex 正在处理此任务" : "当前回合没有继续运行"}</font>` }]
        }]
      },
      {
        tag: "div",
        fields: [
          { is_short: true, text: { tag: "lark_md", content: `**项目**\n${safeMarkdown(project)}` } },
          { is_short: true, text: { tag: "lark_md", content: `**关注**\n${watching ? "已开启" : "未开启"}` } },
          { is_short: true, text: { tag: "lark_md", content: `**本轮**\n${safeMarkdown(turn?.id ? turn.id.slice(0, 8) : thread.rollout?.turnId?.slice(0, 8) ?? "无")}` } },
          { is_short: true, text: { tag: "lark_md", content: `**排队消息**\n${queue.length} 条` } }
        ]
      },
      {
        tag: "collapsible_panel", expanded: true, background_color: "grey-50",
        border: { color: "grey-100", corner_radius: "8px" }, padding: "8px",
        header: { title: plain("最近进展") },
        elements: [{ tag: "markdown", content: safeMarkdown(truncate(progress, 1800)) }]
      },
      actionRow(buttons),
      actionRow(managementButtons)
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
  const managementButtons = [];
  if (detail.page?.isHistorical) managementButtons.push(buttonColumn("返回最新", "progress_detail", {
    threadId: thread.id,
    turnId: detail.turnId
  }, { primary: true }));
  if (detail.page?.nextCursor) managementButtons.push(buttonColumn("更早记录", "progress_detail", {
    threadId: thread.id,
    turnId: detail.turnId,
    cursor: detail.page.nextCursor
  }));
  if (active) managementButtons.push(buttonColumn("停止", "stop", { threadId: thread.id }, {
    danger: true,
    confirm: { title: "停止当前回合？", text: "已经产生的文件修改不会自动撤销。" }
  }));
  else managementButtons.push(buttonColumn("归档", "archive", { threadId: thread.id }, {
    confirm: { title: "归档任务？", text: "归档后可以通过任务 ID 恢复。" }
  }));

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
      actionRow([
        buttonColumn("刷新", "progress_detail", { threadId: thread.id, turnId: detail.turnId }, { primary: true }),
        buttonColumn("返回摘要", "progress", { threadId: thread.id }),
        buttonColumn("继续任务", "send_form", { threadId: thread.id })
      ]),
      ...(managementButtons.length ? [actionRow(managementButtons)] : []),
      actionRow([buttonColumn("返回任务列表", "home", {})])
    ],
    summary: `${threadTitle(thread)}：${detail.currentStage}`
  });
}

export function sendMessageFormCard(thread) {
  return baseCard({
    title: "继续 Codex 任务",
    subtitle: truncate(threadTitle(thread), 80),
    tag: { text: "后续指令", color: "blue" },
    elements: [
      { tag: "form", name: "send_message_form", vertical_spacing: "12px", elements: [
        { tag: "select_static", name: "target_thread", required: true, width: "fill", initial_option: thread.id, options: [{ text: plain(truncate(threadTitle(thread), 80)), value: thread.id }] },
        { tag: "input", name: "message", required: true, input_type: "multiline_text", rows: 6, max_length: 1000, width: "fill", label: plain("发送给 Codex"), placeholder: plain("补充要求、回答问题或要求继续处理") },
        { tag: "button", name: "send_submit", form_action_type: "submit", text: plain("发送"), type: "primary_filled", width: "fill" }
      ] },
      actionRow([buttonColumn("返回任务", "progress", { threadId: thread.id })])
    ],
    summary: `继续任务：${threadTitle(thread)}`
  });
}

export function completionCard(thread, turnStatus, result = "") {
  const completed = turnStatus === "completed";
  const status = completed ? { label: "已完成", template: "green", color: "green" } : effectiveStatus({ status: turnStatus });
  const finalResult = result || thread.rollout?.result || latestAgentMessage(thread) || "任务已结束，未提供最终摘要。";
  return baseCard({
    title: completed ? "Codex 任务已完成" : `Codex 任务${statusLabel(turnStatus)}`,
    subtitle: truncate(threadTitle(thread), 80),
    template: status.template,
    tag: { text: status.label, color: status.color },
    elements: [
      {
        tag: "column_set", flex_mode: "none", columns: [{
          tag: "column", width: "weighted", weight: 1, background_style: `${status.template}-50`, padding: "12px",
          elements: [{ tag: "markdown", content: `**<font color='${status.template}'>${completed ? "任务已完成" : status.label}</font>**\n<font color='grey'>${safeMarkdown(path.basename(thread.cwd ?? "未知项目"))} · ${timeLabel(Date.now())}</font>` }]
        }]
      },
      {
        tag: "collapsible_panel", expanded: true, background_color: "grey-50", border: { color: "grey-100", corner_radius: "8px" }, padding: "8px",
        header: { title: plain("结果摘要") }, elements: [{ tag: "markdown", content: safeMarkdown(truncate(finalResult, 2200)) }]
      },
      actionRow([
        buttonColumn("查看详情", "progress", { threadId: thread.id }, { primary: true }),
        buttonColumn("再次关注", "watch", { threadId: thread.id })
      ])
    ],
    summary: `${threadTitle(thread)}：${status.label}`
  });
}

export function healthCard(health) {
  const ok = health.codexReady && health.larkReady;
  const recovering = !health.codexReady && health.codexRecovery?.recovering;
  const codexStatus = health.codexReady ? "正常" : recovering ? "修复中" : "断开";
  const recoveryStatus = health.codexReady ? "官方服务已连接" :
    recovering ? "正在自动拉起官方服务" :
    health.codexRecovery?.lastError ? `等待重试：${truncate(health.codexRecovery.lastError, 200)}` :
    health.codexRecovery?.enabled ? "等待下一次自动恢复" : "自动恢复未启用";
  return baseCard({
    title: "Codex 助手健康状态",
    subtitle: `v${health.version} · 运行 ${health.uptime}`,
    template: ok ? "green" : "yellow",
    tag: { text: ok ? "运行正常" : "需要关注", color: ok ? "green" : "yellow" },
    elements: [
      { tag: "column_set", flex_mode: "none", horizontal_spacing: "8px", columns: [
        metricColumn(codexStatus, "Codex", health.codexReady ? "green" : recovering ? "yellow" : "red"),
        metricColumn(health.larkReady ? "正常" : "断开", "飞书", health.larkReady ? "green" : "red"),
        metricColumn(health.queuedCount, "等待处理", "violet")
      ] },
      { tag: "div", fields: [
        { is_short: true, text: { tag: "lark_md", content: `**最近消息**\n${timeLabel(health.lastMessageAt)}` } },
        { is_short: true, text: { tag: "lark_md", content: `**最近回复**\n${timeLabel(health.lastReplyAt)}` } },
        { is_short: true, text: { tag: "lark_md", content: `**关注任务**\n${health.watchCount}` } },
        { is_short: true, text: { tag: "lark_md", content: `**自动恢复**\n${safeMarkdown(recoveryStatus)}` } },
        { is_short: false, text: { tag: "lark_md", content: `**最近错误**\n${safeMarkdown(health.lastError ?? "无")}` } }
      ] },
      actionRow([buttonColumn("刷新", "health", {}, { primary: true }), buttonColumn("任务首页", "home", {})])
    ],
    summary: `Codex 助手：${ok ? "运行正常" : "需要关注"}`
  });
}

export function queueCard(items, titleLookup = new Map(), operations = []) {
  const content = items.length === 0 ? "<font color='grey'>没有等待当前回合结束的消息。</font>" : items.map((item, index) => {
    const title = titleLookup.get(item.threadId) ?? item.threadId.slice(0, 8);
    return `**${index + 1}. ${safeMarkdown(title)}**\n${safeMarkdown(truncate(item.text, 180))}`;
  }).join("\n\n");
  const operationContent = operations.length === 0 ? "<font color='grey'>没有等待 Codex 重连的操作。</font>" : operations.map((item, index) => {
    const label = item.type === "create" ? "新建任务" : "继续任务";
    return `**${index + 1}. ${label} · ${safeMarkdown(item.workspace ?? item.threadId?.slice(0, 8) ?? "未知")}**\n${safeMarkdown(truncate(item.text, 180))}\n<font color='grey'>${item.status === "failed" ? `失败：${safeMarkdown(item.lastError ?? "未知错误")}` : "等待自动恢复"}</font>`;
  }).join("\n\n");
  const total = items.length + operations.length;
  return baseCard({
    title: "排队消息",
    subtitle: `${total} 条等待处理`,
    tag: { text: total ? "等待中" : "空", color: total ? "yellow" : "neutral" },
    template: total ? "yellow" : "grey",
    elements: [
      { tag: "collapsible_panel", expanded: true, background_color: "yellow-50", border: { color: "yellow-100", corner_radius: "8px" }, padding: "8px", header: { title: plain("等待当前回合") }, elements: [{ tag: "markdown", content }] },
      { tag: "collapsible_panel", expanded: true, background_color: "violet-50", border: { color: "violet-100", corner_radius: "8px" }, padding: "8px", header: { title: plain("等待服务恢复") }, elements: [{ tag: "markdown", content: operationContent }] },
      actionRow([buttonColumn("刷新", "queue", {}, { primary: true }), buttonColumn("任务首页", "home", {})])
    ]
  });
}

export function stopConfirmCard(thread) {
  return baseCard({
    title: "确认停止任务",
    subtitle: truncate(threadTitle(thread), 80),
    template: "red",
    tag: { text: "危险操作", color: "red" },
    elements: [
      { tag: "column_set", flex_mode: "none", columns: [{ tag: "column", width: "weighted", weight: 1, background_style: "red-50", padding: "12px", elements: [{ tag: "markdown", content: "**停止后不会自动撤销已经产生的文件修改。**\n请确认是否中断当前回合。" }] }] },
      actionRow([
        buttonColumn("确认停止", "stop", { threadId: thread.id }, { danger: true, confirm: { title: "再次确认", text: "确定停止当前 Codex 回合？" } }),
        buttonColumn("取消", "progress", { threadId: thread.id }, { primary: true })
      ])
    ]
  });
}

export function noticeCard({ title, message, template = "blue", status = "提示", action }) {
  return baseCard({
    title,
    subtitle: timeLabel(Date.now()),
    template,
    tag: { text: status, color: template === "grey" ? "neutral" : template },
    elements: [
      { tag: "column_set", flex_mode: "none", columns: [{ tag: "column", width: "weighted", weight: 1, background_style: `${template}-50`, padding: "12px", elements: [{ tag: "markdown", content: safeMarkdown(message) }] }] },
      ...(action ? [actionRow([buttonColumn(action.text, action.action, action.value ?? {}, { primary: true })])] : [])
    ],
    summary: `${title}：${truncate(message, 80)}`
  });
}

export function helpCard() {
  return baseCard({
    title: "Codex 飞书助手",
    subtitle: "个人远程控制台 · v0.1.0",
    tag: { text: "使用帮助", color: "blue" },
    elements: [
      { tag: "column_set", flex_mode: "none", columns: [{ tag: "column", width: "weighted", weight: 1, background_style: "blue-50", padding: "12px", vertical_spacing: "4px", elements: [{ tag: "markdown", content: "**直接说要做什么即可**\n例如：`帮我查最近一个 PR 是谁的`。助手会自动新建任务；回复某张任务卡会继续对应任务。" }] }] },
      { tag: "markdown", content: "**图片、文件和语音**\n直接发送即可；回复任务卡发送时会补充到该任务。语音支持 60 秒以内中英混合转写。\n\n**定时任务**\n`定时 每天 09:00 android-main 检查 CI`\n`定时 明天 10:30 memory 汇总进度`　`定时任务`\n\n**精确控制（备用）**\n`任务`　`新建`　`进度1`　`详情1`　`继续1 消息`　`停止1`　`归档1`\n`队列`　`静默 2小时`　`恢复通知`　`健康`　`版本`" },
      { tag: "column_set", flex_mode: "none", columns: [{ tag: "column", width: "weighted", weight: 1, background_style: "yellow-50", padding: "12px", elements: [{ tag: "markdown", content: "<font color='grey'>只接受已配置用户的私聊；不会在飞书内处理高风险审批，也不会删除任务。</font>" }] }] },
      actionRow([buttonColumn("任务首页", "home", {}, { primary: true }), buttonColumn("新建任务", "create_form", {})])
    ],
    summary: "Codex 飞书助手使用帮助"
  });
}

export function clarificationCard(pending, currentThread, workspace) {
  return baseCard({
    title: "确认这条消息要发到哪里",
    subtitle: "助手保留了原消息，选择后立即执行",
    template: "yellow",
    tag: { text: "需要确认", color: "yellow" },
    elements: [
      {
        tag: "column_set", flex_mode: "none", columns: [{
          tag: "column", width: "weighted", weight: 1, background_style: "yellow-50", padding: "12px", vertical_spacing: "4px",
          elements: [
            { tag: "markdown", content: `**${safeMarkdown(truncate(pending.message, 300))}**` },
            { tag: "markdown", content: `<font color='grey'>当前任务：${safeMarkdown(truncate(threadTitle(currentThread), 80))}\n新任务项目：${safeMarkdown(workspace)}</font>`, text_size: "caption" }
          ]
        }]
      },
      actionRow([
        buttonColumn("继续当前任务", "clarify_continue", { pendingId: pending.id }, { primary: true }),
        buttonColumn("新建任务", "clarify_create", { pendingId: pending.id })
      ]),
      actionRow([buttonColumn("取消", "clarify_cancel", { pendingId: pending.id })])
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
      { tag: "markdown", content: `<text_tag color='${status.color}'>${status.label}</text_tag>  <font color='grey'>${safeMarkdown(schedule.label)} · ${safeMarkdown(schedule.workspace)}</font>`, text_size: "caption" }
    ]
  };
}

export function scheduleListCard(schedules) {
  const active = schedules.filter((schedule) => schedule.status === "active").length;
  const paused = schedules.filter((schedule) => schedule.status === "paused").length;
  return baseCard({
    title: "Codex 定时任务",
    subtitle: `${schedules.length} 个计划 · 本机时区执行`,
    tag: { text: "自动化", color: "blue" },
    elements: [
      { tag: "column_set", flex_mode: "none", horizontal_spacing: "8px", columns: [
        metricColumn(active, "已启用"),
        metricColumn(paused, "已暂停", "yellow"),
        metricColumn(schedules.filter((schedule) => schedule.status === "completed").length, "已完成", "green")
      ] },
      {
        tag: "collapsible_panel", expanded: true, background_color: "grey-50",
        border: { color: "grey-100", corner_radius: "8px" }, padding: "8px", vertical_spacing: "8px",
        header: { title: plain("最近计划") },
        elements: schedules.length ? schedules.slice(0, 8).map(scheduleBlock) : [{ tag: "markdown", content: "<font color='grey'>还没有定时任务。</font>" }]
      },
      { tag: "column_set", flex_mode: "none", columns: [{ tag: "column", width: "weighted", weight: 1, background_style: "blue-50", padding: "12px", elements: [{ tag: "markdown", content: "**创建示例**\n`定时 每天 09:00 android-main 检查 CI`" }] }] },
      actionRow([buttonColumn("刷新", "schedule_list", {}, { primary: true }), buttonColumn("任务首页", "home", {})])
    ],
    summary: `Codex 定时任务：${active} 个已启用`
  });
}

export function scheduleDetailCard(schedule) {
  const status = scheduleStatus(schedule);
  const actions = [];
  if (schedule.status === "active") actions.push(buttonColumn("暂停", "schedule_pause", { scheduleId: schedule.id }, { primary: true }));
  if (schedule.status === "paused") actions.push(buttonColumn("恢复", "schedule_resume", { scheduleId: schedule.id }, { primary: true }));
  if (!["canceled", "completed"].includes(schedule.status)) {
    actions.push(buttonColumn("取消", "schedule_cancel", { scheduleId: schedule.id }, {
      danger: true,
      confirm: { title: "取消定时任务？", text: "已创建的 Codex 任务不会受影响。" }
    }));
  }
  return baseCard({
    title: "定时任务详情",
    subtitle: truncate(schedule.prompt, 80),
    template: status.color === "neutral" ? "grey" : status.color,
    tag: { text: status.label, color: status.color },
    elements: [
      { tag: "div", fields: [
        { is_short: true, text: { tag: "lark_md", content: `**计划**\n${safeMarkdown(schedule.label)}` } },
        { is_short: true, text: { tag: "lark_md", content: `**项目**\n${safeMarkdown(schedule.workspace)}` } },
        { is_short: true, text: { tag: "lark_md", content: `**下次执行**\n${timeLabel(schedule.nextRunAt)}` } },
        { is_short: true, text: { tag: "lark_md", content: `**最近任务**\n${schedule.lastThreadId?.slice(0, 8) ?? "无"}` } }
      ] },
      { tag: "column_set", flex_mode: "none", columns: [{ tag: "column", width: "weighted", weight: 1, background_style: `${status.color === "neutral" ? "grey" : status.color}-50`, padding: "12px", elements: [{ tag: "markdown", content: `**任务内容**\n${safeMarkdown(truncate(schedule.prompt, 1000))}` }] }] },
      ...(actions.length ? [actionRow(actions)] : []),
      actionRow([buttonColumn("返回定时列表", "schedule_list", {}, { primary: actions.length === 0 })])
    ],
    summary: `${schedule.prompt}：${status.label}`
  });
}

export function parseActionValue(raw) {
  if (!raw) return {};
  if (typeof raw === "object") return raw;
  try { return JSON.parse(raw); } catch { return { action: raw }; }
}
