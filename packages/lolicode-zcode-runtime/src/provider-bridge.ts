/** Channel credentials remain in the Rust gateway. This layer only receives its
 * local lease and freezes a versioned model catalog for native ZCode. */
export type CatalogModel = {
  id: string;
  providerId: string;
  modelId: string;
  name: string;
  channelName: string;
  contextLimit?: number;
  outputLimit?: number;
  reasoningEfforts?: string[];
};
export type Catalog = {
  revision: number;
  models: CatalogModel[];
  defaultModel?: string;
  excludedSources?: unknown[];
};
export type Gateway = { baseUrl: string; bearerToken: string };

function groupModels(models: CatalogModel[]): Map<string, CatalogModel[]> {
  const grouped = new Map<string, CatalogModel[]>();
  for (const model of models) {
    const items = grouped.get(model.providerId) ?? [];
    items.push(model);
    grouped.set(model.providerId, items);
  }
  return grouped;
}

export function validateGateway(gateway: Gateway): void {
  const url = new URL(gateway.baseUrl);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !gateway.bearerToken?.trim()
  ) {
    throw new Error(
      "LoliCode gateway must be an authenticated private loopback endpoint",
    );
  }
}

export function nativeSelection(catalog: Catalog, id: string) {
  const model = catalog.models.find((item) => item.id === id);
  if (!model) throw new Error("此模型不在当前渠道目录中，请刷新模型目录");
  // Catalog.id is the renderer's provider/model picker key. Catalog.modelId is
  // already the opaque, channel-specific gateway route, not the upstream ID.
  return {
    providerId: model.providerId,
    modelId: model.modelId,
    options: { reasoningLevel: model.reasoningEfforts?.[0] ?? "default" },
  };
}

export function visibleSelection(catalog: Catalog, selection: any) {
  if (!selection) return null;
  const entry = catalog.models.find(
    (model) =>
      model.providerId === selection.providerId &&
      model.modelId === selection.modelId,
  );
  return entry
    ? { providerId: entry.providerId, modelId: entry.modelId }
    : { providerId: selection.providerId, modelId: selection.modelId };
}

export function modelConfig(model: CatalogModel) {
  return {
    enabled: true,
    properties: {
      requiresMfjsToolSchema: false,
      contextWindow:
        model.contextLimit && model.contextLimit > 0
          ? model.contextLimit
          : 128_000,
      inputFormat: {
        supportsText: true,
        supportsImage: false,
        supportsVideo: false,
        supportsAudio: false,
        supportsPdf: false,
      },
      outputFormat: { supportsText: true },
      supportsToolCall: true,
      supportsJsonSchemaOutput: false,
      supportsNativeWebSearch: false,
      supportsMidConversationSystem: true,
    },
    optionSpecs: {
      reasoningLevel: {
        values: model.reasoningEfforts?.length
          ? model.reasoningEfforts
          : ["default"],
        map: model.reasoningEfforts?.length
          ? '{"reasoning_effort": reasoningLevel}'
          : "{}",
      },
      maxOutputTokens: {
        max:
          model.outputLimit && model.outputLimit > 0
            ? model.outputLimit
            : 16_384,
        map: '{"max_tokens": maxOutputTokens}',
      },
    },
  };
}

/** Native personal-model mutations accept the upstream manual-model schema,
 * which intentionally excludes registry-only system capability/mapping fields. */
export function manualModelConfig(model: CatalogModel) {
  const full = modelConfig(model);
  return {
    enabled: full.enabled,
    properties: {
      contextWindow: full.properties.contextWindow,
      supportsJsonSchemaOutput: full.properties.supportsJsonSchemaOutput,
      supportsNativeWebSearch: full.properties.supportsNativeWebSearch,
      supportsMidConversationSystem:
        full.properties.supportsMidConversationSystem,
      inputFormat: {
        supportsImage: full.properties.inputFormat.supportsImage,
        supportsVideo: full.properties.inputFormat.supportsVideo,
        supportsPdf: full.properties.inputFormat.supportsPdf,
      },
    },
    optionSpecs: {
      reasoningLevel: full.optionSpecs.reasoningLevel,
      maxOutputTokens: { max: full.optionSpecs.maxOutputTokens.max },
    },
  };
}

export function providerFile(catalog: Catalog, gateway: Gateway) {
  validateGateway(gateway);
  const grouped = groupModels(catalog.models);
  return {
    schemaVersion: 1,
    config: {
      providerOrder: [...grouped.keys()],
      providerConfigRules: {
        providerRules: [...grouped].map(([providerId, models]) => ({
          providerId,
          providerName: models[0].channelName,
          enabled: true,
          config: {
            group: "standard-personal",
            visibility: "visible",
            access: { type: "api-key", apiKey: gateway.bearerToken },
            api: { type: "openai-chat-completions", baseUrl: gateway.baseUrl },
            personalModelIds: models.map((item) => item.modelId),
            modelOrder: models.map((item) => item.modelId),
          },
        })),
      },
      modelConfigRules: {
        providerModelRules: catalog.models.map((model) => ({
          providerId: model.providerId,
          modelId: model.modelId,
          config: modelConfig(model),
        })),
        manualProviderModelRules: [],
      },
      ...(catalog.defaultModel &&
      catalog.models.some((m) => m.id === catalog.defaultModel)
        ? {
            defaultModelSelection: nativeSelection(
              catalog,
              catalog.defaultModel,
            ),
          }
        : {}),
    },
  };
}

export const emptyBuiltinFile = {
  schemaVersion: 1,
  revision: 1,
  config: {
    providerConfigRules: { templateRules: [], providerRules: [] },
    modelConfigRules: {
      modelRules: [],
      modelApiRules: [],
      providerSiteRules: [],
      templateModelRules: [],
      builtinProviderModelRules: [],
    },
  },
};

/** The remote endpoint is a relay on the remote host, authenticated with a
 * separate ephemeral token. The desktop gateway token never leaves this host. */
export async function provisionRemoteCatalog(
  services: any,
  descriptor: any,
  catalog: Catalog,
  baseUrl: string,
  apiKey: string,
) {
  const settings =
    services.get?.(descriptor) ?? services.providerSettingsService;
  const owned: string[] = [];
  try {
    for (const [channel, models] of groupModels(catalog.models)) {
      const created = await settings.createPersonalProvider({
        providerName: models[0].channelName,
      });
      owned.push(created.providerId);
      await settings.savePersonalProviderOverlay(created.providerId, {
        group: "standard-personal",
        visibility: "visible",
        access: { type: "api-key", apiKey },
        api: { type: "openai-chat-completions", baseUrl },
      });
      // addPersonalModel owns membership and ordering; prepopulating the member
      // IDs would cause the native mutation to reject every model as existing.
      for (const model of models)
        await settings.addPersonalModel(
          created.providerId,
          model.modelId,
          manualModelConfig(model),
          false,
        );
      // Remote raw APIs select the actual provider ID returned by native ZCode;
      // provider names preserve the channel the user chose in LoliCode.
      void channel;
    }
  } catch (error) {
    await Promise.allSettled(
      owned.map((id) => settings.deletePersonalProvider(id)),
    );
    throw error;
  }
  return {
    dispose: async () => {
      await Promise.allSettled(
        owned.map((id) => settings.deletePersonalProvider(id)),
      );
    },
  };
}
