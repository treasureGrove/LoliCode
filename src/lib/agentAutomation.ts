const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

export interface AgentAutomationProposal {
  type: "automation_proposal";
  version: 1;
  automationId?: string;
  savedAutomationId?: string;
  input: {
    title: string;
    prompt: string;
    trigger: "schedule" | "idle";
    cronExpr?: string;
    idleAfterMinutes?: number;
    idleIntervalMinutes?: number;
    mode?: "build" | "guarded" | "yolo";
  };
}

export function parseAutomationProposal(
  output?: string | null,
): AgentAutomationProposal | null {
  try {
    const value = JSON.parse(output || "null") as AgentAutomationProposal;
    const input = value?.input;
    if (
      value?.type !== "automation_proposal" ||
      value.version !== 1 ||
      !input ||
      typeof input.title !== "string" ||
      !input.title.trim() ||
      [...input.title.trim()].length > 160 ||
      typeof input.prompt !== "string" ||
      !input.prompt.trim() ||
      new TextEncoder().encode(input.prompt).length > 64 * 1024 ||
      (value.automationId !== undefined &&
        (typeof value.automationId !== "string" ||
          !value.automationId.trim())) ||
      (value.savedAutomationId !== undefined &&
        (typeof value.savedAutomationId !== "string" ||
          !value.savedAutomationId.trim())) ||
      (input.mode !== undefined &&
        !["build", "guarded", "yolo"].includes(input.mode))
    )
      return null;
    if (input.trigger === "schedule") {
      if (
        typeof input.cronExpr !== "string" ||
        automationScheduleLabel(input.cronExpr) === "自定义计划"
      )
        return null;
    } else if (input.trigger === "idle") {
      if (
        !Number.isInteger(input.idleAfterMinutes) ||
        !Number.isInteger(input.idleIntervalMinutes) ||
        input.idleAfterMinutes! < 1 ||
        input.idleAfterMinutes! > 1440 ||
        input.idleIntervalMinutes! < 1 ||
        input.idleIntervalMinutes! > 10080
      )
        return null;
    } else return null;
    return {
      type: "automation_proposal",
      version: 1,
      ...(value.automationId ? { automationId: value.automationId } : {}),
      ...(value.savedAutomationId
        ? { savedAutomationId: value.savedAutomationId }
        : {}),
      input: {
        title: input.title.trim(),
        prompt: input.prompt.trim(),
        trigger: input.trigger,
        ...(input.trigger === "schedule"
          ? { cronExpr: input.cronExpr!.trim() }
          : {
              idleAfterMinutes: input.idleAfterMinutes,
              idleIntervalMinutes: input.idleIntervalMinutes,
            }),
        ...(input.mode ? { mode: input.mode } : {}),
      },
    };
  } catch {
    return null;
  }
}

export function automationProposalSchedule(
  proposal: AgentAutomationProposal,
): string {
  const input = proposal.input;
  return input.trigger === "idle"
    ? `闲置 ${input.idleAfterMinutes} 分钟后 · 至少间隔 ${input.idleIntervalMinutes} 分钟`
    : automationScheduleLabel(input.cronExpr || "");
}
export function automationCron(
  frequency: string,
  time: string,
  weekday: string,
  minute: string,
): string {
  if (frequency === "hourly") {
    if (!/^\d{1,2}$/.test(minute) || Number(minute) > 59)
      throw new Error("请选择每小时 0–59 分钟中的一个时间");
    return `${Number(minute)} * * * *`;
  }
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59)
    throw new Error("请选择有效的运行时间");
  if (!["daily", "weekly"].includes(frequency))
    throw new Error("请选择运行频率");
  if (frequency === "weekly" && !/^[0-6](,[0-6])*$/.test(weekday))
    throw new Error("请至少选择一个运行星期");
  const days = [...new Set(weekday.split(","))].sort().join(",");
  return `${Number(match[2])} ${Number(match[1])} * * ${frequency === "weekly" ? days : "*"}`;
}

export function automationScheduleLabel(cron: string): string {
  const fields = cron.trim().split(/\s+/);
  if (
    fields.length !== 5 ||
    !/^\d{1,2}$/.test(fields[0]) ||
    Number(fields[0]) > 59 ||
    fields[2] !== "*" ||
    fields[3] !== "*"
  )
    return "自定义计划";
  const minute = fields[0].padStart(2, "0");
  if (fields[1] === "*" && fields[4] === "*") return `每小时 ${minute} 分`;
  if (!/^\d{1,2}$/.test(fields[1]) || Number(fields[1]) > 23)
    return "自定义计划";
  const time = `${fields[1].padStart(2, "0")}:${minute}`;
  if (fields[4] === "*") return `每天 ${time}`;
  if (/^[0-6](,[0-6])*$/.test(fields[4]))
    return `每周${[...new Set(fields[4].split(","))]
      .sort()
      .map((day) => WEEKDAYS[Number(day)])
      .join("、")} ${time}`;
  return "自定义计划";
}
