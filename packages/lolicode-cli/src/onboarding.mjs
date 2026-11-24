const providers = [
  {
    id: "deepseek",
    label: "DeepSeek",
    baseURL: "https://api.deepseek.com",
    api: "openai-completions",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    models: ["deepseek-flash", "deepseek-v4-pro"],
  },
  {
    id: "openai",
    label: "OpenAI",
    baseURL: "https://api.openai.com/v1",
    api: "openai-responses",
    apiKeyEnv: "OPENAI_API_KEY",
    models: ["gpt-5-mini", "gpt-5"],
  },
  {
    id: "anthropic",
    label: "Anthropic",
    baseURL: "https://api.anthropic.com",
    api: "anthropic-messages",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    models: ["claude-sonnet-5-5", "claude-haiku-5-5"],
  },
];

const protocols = [
  { label: "OpenAI 兼容 · Chat Completions", api: "openai-completions" },
  { label: "OpenAI · Responses", api: "openai-responses" },
  { label: "Anthropic · Messages", api: "anthropic-messages" },
];

function channelName(config, base) {
  let name = base;
  for (let suffix = 2; Object.hasOwn(config.channels, name); suffix++)
    name = `${base}-${suffix}`;
  return name;
}

function savedChannels(config) {
  const entries = Object.entries(config.channels);
  return entries.sort(([left], [right]) =>
    Number(right === config.selected) - Number(left === config.selected));
}

async function field(ui, label) {
  while (ui.canAsk) {
    const value = (await ui.ask(label))?.trim();
    if (value === undefined || value === "/cancel") return undefined;
    if (value) return value;
    ui.note("请填写内容，或输入 /cancel 返回。");
  }
  return undefined;
}

export async function chooseConnection(config, ui) {
  const entries = [
    ...savedChannels(config).map(([name, channel]) => ({
      label: `${name} / ${channel.model} · 已保存`,
      name,
      channel,
      existing: true,
    })),
    ...providers.map((provider) => ({
      label: provider.label,
      provider,
    })),
    { label: "自定义 API / 网关" },
  ];
  const choice = await ui.choose("选择服务商", entries.map(({ label }) => label));
  const entry = entries[choice];
  if (!entry || entry.existing) return entry;
  if (entry.provider) {
    const { id, label, baseURL, api, apiKeyEnv, models } = entry.provider;
    const selected = await ui.choose(`选择模型 · ${label}`, [...models, "手动输入模型 ID"]);
    if (selected === undefined) return undefined;
    const model = models[selected] || await field(ui, "模型 ID: ");
    if (!model) return undefined;
    return { name: channelName(config, id), channel: { baseURL, api, apiKeyEnv, model } };
  }

  const baseURL = await field(ui, "API 地址: ");
  if (!baseURL) return undefined;
  const selected = await ui.choose("选择接口协议", protocols.map(({ label }) => label));
  if (selected === undefined) return undefined;
  const model = await field(ui, "模型 ID: ");
  if (!model) return undefined;
  const name = channelName(config, "custom");
  const apiKeyEnv = `LOLICODE_${name.replaceAll("-", "_").toUpperCase()}_API_KEY`;
  return { name, channel: { baseURL, api: protocols[selected].api, apiKeyEnv, model } };
}

export async function chooseModel(config, ui, current) {
  const choices = savedChannels(config).flatMap(([name, channel]) => {
    // API-compatible gateways can have different models, even when using a
    // protocol shared by a preset. Only show presets at their official URL.
    const provider = providers.find((item) =>
      item.baseURL === channel.baseURL && item.api === channel.api);
    const models = [...new Set([channel.model, ...(provider?.models ?? [])])];
    return models.map((model) => ({ name, model }));
  });
  if (!choices.length) {
    ui.note("还没有已保存的模型。输入 /connect 连接服务商。");
    return undefined;
  }
  choices.sort((left, right) =>
    Number(right.name === current?.name && right.model === current.model) -
    Number(left.name === current?.name && left.model === current.model));
  const choice = await ui.choose("选择模型", choices.map(({ name, model }) => `${name} / ${model}`));
  return choices[choice];
}
