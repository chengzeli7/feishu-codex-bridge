const WEEKDAYS = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 };

function zonedParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  });
  return Object.fromEntries(formatter.formatToParts(date)
    .filter((part) => part.type !== "literal")
    .map((part) => [part.type, Number(part.value)]));
}

function zonedDate({ year, month, day, hour, minute, second = 0 }, timeZone) {
  const target = Date.UTC(year, month - 1, day, hour, minute, second);
  let guess = target;
  for (let index = 0; index < 3; index += 1) {
    const actual = zonedParts(new Date(guess), timeZone);
    const actualValue = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second);
    guess += target - actualValue;
  }
  return new Date(guess);
}

function addCalendarDays(parts, days) {
  const value = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return {
    year: value.getUTCFullYear(),
    month: value.getUTCMonth() + 1,
    day: value.getUTCDate()
  };
}

function parseClock(hourText, minuteText = "0") {
  const hour = Number(hourText);
  const minute = Number(minuteText || 0);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) {
    throw new Error("时间需要使用 00:00–23:59");
  }
  return { hour, minute };
}

function clockPattern() {
  return "(\\d{1,2})(?:(?::|点)(\\d{1,2})?)?";
}

export function parseScheduleExpression(expression, {
  now = new Date(),
  timeZone = "Asia/Shanghai",
  defaultWorkspace,
  detectWorkspace
} = {}) {
  const text = String(expression ?? "").trim();
  if (!text) throw new Error("定时任务缺少执行时间和任务内容");
  let match;
  let spec;
  let prompt;

  match = text.match(new RegExp(`^(\\d+)\\s*分钟后\\s+([\\s\\S]+)$`));
  if (match) {
    const amount = Number(match[1]);
    if (amount < 1 || amount > 10_080) throw new Error("分钟数需要在 1–10080 之间");
    spec = { kind: "once", at: now.getTime() + amount * 60_000 };
    prompt = match[2].trim();
  }

  if (!spec) {
    match = text.match(new RegExp(`^(\\d+)\\s*小时后\\s+([\\s\\S]+)$`));
    if (match) {
      const amount = Number(match[1]);
      if (amount < 1 || amount > 168) throw new Error("小时数需要在 1–168 之间");
      spec = { kind: "once", at: now.getTime() + amount * 3_600_000 };
      prompt = match[2].trim();
    }
  }

  if (!spec) {
    match = text.match(new RegExp(`^(明天|后天)\\s*${clockPattern()}\\s+([\\s\\S]+)$`));
    if (match) {
      const clock = parseClock(match[2], match[3]);
      const current = zonedParts(now, timeZone);
      const date = addCalendarDays(current, match[1] === "明天" ? 1 : 2);
      spec = { kind: "once", at: zonedDate({ ...date, ...clock }, timeZone).getTime() };
      prompt = match[4].trim();
    }
  }

  if (!spec) {
    match = text.match(new RegExp(`^(\\d{4})-(\\d{1,2})-(\\d{1,2})\\s+${clockPattern()}\\s+([\\s\\S]+)$`));
    if (match) {
      const clock = parseClock(match[4], match[5]);
      const at = zonedDate({
        year: Number(match[1]), month: Number(match[2]), day: Number(match[3]), ...clock
      }, timeZone).getTime();
      if (at <= now.getTime()) throw new Error("一次性定时任务必须晚于当前时间");
      spec = { kind: "once", at };
      prompt = match[6].trim();
    }
  }

  if (!spec) {
    match = text.match(new RegExp(`^每天\\s*${clockPattern()}\\s+([\\s\\S]+)$`));
    if (match) {
      spec = { kind: "daily", ...parseClock(match[1], match[2]) };
      prompt = match[3].trim();
    }
  }

  if (!spec) {
    match = text.match(new RegExp(`^每周([一二三四五六日天])\\s*${clockPattern()}\\s+([\\s\\S]+)$`));
    if (match) {
      spec = { kind: "weekly", weekday: WEEKDAYS[match[1]], ...parseClock(match[2], match[3]) };
      prompt = match[4].trim();
    }
  }

  if (!spec || !prompt) {
    throw new Error("无法识别定时表达式。示例：定时 每天 09:00 android-main 检查 CI");
  }
  if (prompt.length > 4_000) throw new Error("定时任务内容不能超过 4000 个字符");

  const workspace = detectWorkspace?.(prompt) ?? defaultWorkspace;
  if (!workspace) throw new Error("定时任务没有可用项目");
  return {
    spec,
    prompt,
    workspace,
    timeZone,
    nextRunAt: nextScheduleRun(spec, now, timeZone)
  };
}

export function nextScheduleRun(spec, after = new Date(), timeZone = "Asia/Shanghai") {
  if (spec.kind === "once") return Number(spec.at);
  const current = zonedParts(after, timeZone);
  const today = { year: current.year, month: current.month, day: current.day };
  if (spec.kind === "daily") {
    let candidate = zonedDate({ ...today, hour: spec.hour, minute: spec.minute }, timeZone);
    if (candidate.getTime() <= after.getTime()) {
      candidate = zonedDate({ ...addCalendarDays(today, 1), hour: spec.hour, minute: spec.minute }, timeZone);
    }
    return candidate.getTime();
  }
  if (spec.kind === "weekly") {
    const currentWeekday = currentWeekdayInZone(after, timeZone);
    let days = (spec.weekday - currentWeekday + 7) % 7;
    let candidate = zonedDate({ ...addCalendarDays(today, days), hour: spec.hour, minute: spec.minute }, timeZone);
    if (candidate.getTime() <= after.getTime()) {
      days += 7;
      candidate = zonedDate({ ...addCalendarDays(today, days), hour: spec.hour, minute: spec.minute }, timeZone);
    }
    return candidate.getTime();
  }
  throw new Error(`unsupported schedule kind: ${spec.kind}`);
}

function currentWeekdayInZone(date, timeZone) {
  const parts = zonedParts(date, timeZone);
  const weekday = new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
  return weekday === 0 ? 7 : weekday;
}

export function scheduleLabel(schedule) {
  const spec = schedule.spec;
  const time = `${String(spec.hour ?? 0).padStart(2, "0")}:${String(spec.minute ?? 0).padStart(2, "0")}`;
  if (spec.kind === "daily") return `每天 ${time}`;
  if (spec.kind === "weekly") {
    const name = Object.entries(WEEKDAYS).find(([key, value]) => key !== "天" && value === spec.weekday)?.[0] ?? spec.weekday;
    return `每周${name} ${time}`;
  }
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: schedule.timeZone ?? "Asia/Shanghai",
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false
  }).format(new Date(spec.at));
}
