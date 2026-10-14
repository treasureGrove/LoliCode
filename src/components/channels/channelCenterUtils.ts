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
  const previousSelections = new Map(
    previous?.models.map((model) => [model.id, model.enabled !== false]),
  );
  return {
    ...discovered,
    enabled: previous?.enabled ?? discovered.enabled,
    models: discovered.models.map((model) => ({
      ...model,
      enabled:
        previousSelections.get(model.id) ??
        (model.enabled !== false && model.supportsTools !== false),
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
