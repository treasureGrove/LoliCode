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
    model.contextLimit
      ? `上下文 ${model.contextLimit.toLocaleString()} tokens`
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
export function channelErrorMessage(error: unknown, secrets: string[] = []) {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of secrets.filter(Boolean)) {
    message = message.split(secret).join("[已隐藏]");
  }
  if (/401|403|unauthorized|forbidden|invalid.?key/i.test(message)) {
    return "没有访问权限，请检查 API Key 或重新登录账号。";
  }
  if (/timeout|timed out|network|fetch failed|connection/i.test(message)) {
    return "连接失败，请检查 API 地址和网络后重试。";
  }
  if (/404|not found/i.test(message)) {
    return "没有找到模型列表，请检查 API 地址是否完整。";
  }
  if (/[\u4e00-\u9fff]/.test(message) && !/[{}]|https?:\/\//i.test(message)) {
    return message.slice(0, 240);
  }
  return "操作未完成，请检查地址、密钥或账号后重试。";
}
