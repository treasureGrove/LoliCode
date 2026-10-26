import type {
  ChannelCenterSnapshot,
  ChannelModel,
  ChannelSource,
} from "@/lib/api/channel-center";

export function selectedChannelModels(snapshot: ChannelCenterSnapshot) {
  return snapshot.channels.flatMap((channel) =>
    channel.enabled
      ? channel.models
          .filter(
            (model) => model.enabled !== false && model.supportsTools !== false,
          )
          .map((model) => ({
            channel,
            model,
            value: `${channel.id}/${model.id}`,
          }))
      : [],
  );
}

export function withValidDefault(snapshot: ChannelCenterSnapshot) {
  const selected = selectedChannelModels(snapshot);
  return {
    ...snapshot,
    defaultModel: selected.some((item) => item.value === snapshot.defaultModel)
      ? snapshot.defaultModel
      : selected[0]?.value,
  };
}

/** Refresh catalog without resetting the user's existing model selections. */
export function mergeDiscoveredChannel(
  discovered: ChannelSource,
  previous?: ChannelSource,
): ChannelSource {
  const previousModels = new Map(
    previous?.models.map((model) => [model.id, model]),
  );
  return {
    ...discovered,
    enabled: previous?.enabled ?? discovered.enabled,
    models: discovered.models.map((model) => ({
      ...model,
      selectedContextLimit: model.contextLimits?.includes(
        previousModels.get(model.id)?.selectedContextLimit ?? -1,
      )
        ? previousModels.get(model.id)?.selectedContextLimit
        : model.selectedContextLimit,
      enabled: previousModels.has(model.id)
        ? previousModels.get(model.id)!.enabled !== false
        : model.enabled !== false && model.supportsTools !== false,
    })),
  };
}

export function matchesChannelModel(
  channel: ChannelSource,
  model: ChannelModel,
  search: string,
) {
  const needle = search.trim().toLocaleLowerCase();
  return `${channel.name} ${model.id} ${model.name ?? ""}`
    .toLocaleLowerCase()
    .includes(needle);
}

export function channelModelMetadata(
  channel: ChannelSource,
  model: ChannelModel,
) {
  const native =
    channel.authKind === "claude_subscription" ||
    channel.authKind === "gemini_subscription";
  if (native) return "由原生工具管理";
  const parts = [
    model.supportsTools === false
      ? "上游标注不支持工具调用"
      : model.supportsTools === true
        ? "上游标注支持工具调用"
        : "上游未提供工具能力",
  ];
  parts.push(
    model.contextLimits && model.contextLimits.length > 1
      ? `上下文 ${model.contextLimits.map((limit) => limit.toLocaleString()).join(" / ")} tokens（当前 ${(model.selectedContextLimit ?? model.contextLimit)?.toLocaleString() ?? "渠道默认"}）`
      : model.contextLimit
        ? `上下文 ${(model.selectedContextLimit ?? model.contextLimit).toLocaleString()} tokens`
        : "上下文：上游未提供",
  );
  if (model.outputLimit)
    parts.push(`最大输出 ${model.outputLimit.toLocaleString()} tokens`);
  if (model.reasoningEfforts?.length)
    parts.push(`思考强度：${model.reasoningEfforts.join(" / ")}`);
  else if (model.reasoningEfforts) parts.push("思考强度不可调");
  else parts.push("思考强度：上游未提供");
  return parts.join(" · ");
}

/** Never show request dumps or credentials if a lower layer returns a raw error. */
export function channelErrorMessage(
  error: unknown,
  secrets: string[] = [],
  scope: "channel" | "configuration" = "channel",
) {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of secrets.filter(Boolean)) {
    message = message.split(secret).join("[已隐藏]");
  }
  if (scope === "configuration") {
    if (
      /permission denied|access (?:is )?denied|EACCES|EPERM|os error (?:5|13)\b/i.test(
        message,
      )
    ) {
      return "无法写入工具配置，请检查配置目录的写入权限，以及文件是否被其他程序占用。";
    }
    if (
      /\bbusy\b|\blocked\b|sharing violation|os error (?:32|33)\b/i.test(
        message,
      )
    ) {
      return "工具配置正在被占用，请等待该工具完成保存后重试。";
    }
    if (
      /parse error|parse failure|failed to parse|invalid (?:JSON|JSONC|TOML|YAML)|expected .* at line|unknown field|unknown variant/i.test(
        message,
      )
    ) {
      return "工具现有配置的格式或字段不兼容，请检查该工具的 JSON、TOML 或 YAML 配置后重试。";
    }
    if (
      /no such file|file not found|path not found|os error (?:2|3)\b/i.test(
        message,
      )
    ) {
      return "没有找到工具的配置文件或目录，请检查该工具的配置路径后重试。";
    }
    if (/provider.*(?:already exists|conflict)|same.*provider/i.test(message)) {
      return "工具中已有同名配置，请调整渠道标识后重试，已有配置会保留。";
    }
    // Native writers often provide a precise localized error. Preserve it before
    // applying network/catalog heuristics to unrelated words such as "connection".
    if (/[\u4e00-\u9fff]/.test(message) && !/[{}]|https?:\/\//i.test(message)) {
      return message.slice(0, 240);
    }
  }
  if (/401|403|unauthorized|forbidden|invalid.?key/i.test(message)) {
    return "没有访问权限，请检查 API Key 或重新登录账号。";
  }
  if (
    /timeout|timed out|network|fetch failed|connection (?:refused|reset|failed|closed|aborted)|error sending request/i.test(
      message,
    )
  ) {
    return "连接失败，请检查 API 地址和网络后重试。";
  }
  if (/404|not found/i.test(message)) {
    if (scope === "configuration") {
      return "工具配置引用的模型或资源不存在，请刷新渠道模型并检查该工具的配置。";
    }
    return "没有找到模型列表，请检查 API 地址是否完整。";
  }
  if (/[\u4e00-\u9fff]/.test(message) && !/[{}]|https?:\/\//i.test(message)) {
    return message.slice(0, 240);
  }
  return scope === "configuration"
    ? "工具配置未完成，请检查该工具的配置格式、写入权限及所选模型后重试。"
    : "操作未完成，请检查地址、密钥或账号后重试。";
}
