import { describe, expect, it } from "vitest";
import {
  manualModelConfig,
  modelConfig,
  nativeSelection,
  providerFile,
  provisionRemoteCatalog,
  validateGateway,
  visibleSelection,
  type Catalog,
} from "../../packages/lolicode-zcode-runtime/src/provider-bridge";
import {
  collaborationMode,
  permissionDto,
  rowMessages,
  nativeSnapshotBusy,
} from "../../packages/lolicode-zcode-runtime/src/compat";

const catalog: Catalog = {
  revision: 1,
  defaultModel: "channel-a/model",
  models: [
    {
      id: "channel-a/model",
      providerId: "a",
      modelId: "same-model",
      name: "Model A",
      channelName: "Channel A",
      contextLimit: 32000,
      outputLimit: 4000,
      reasoningEfforts: ["low", "high"],
    },
    {
      id: "channel-b/model",
      providerId: "b",
      modelId: "same-model",
      name: "Model B",
      channelName: "Channel B",
    },
  ],
};
const gateway = {
  baseUrl: "http://127.0.0.1:34567/catalog/1/v1",
  bearerToken: "fixture-lease",
};

describe("ZCode channel and existing renderer boundary", () => {
  it("keeps two channels offering the same model separate through execution and display", () => {
    const a = nativeSelection(catalog, "channel-a/model");
    const b = nativeSelection(catalog, "channel-b/model");
    expect(a).not.toEqual(b);
    expect(visibleSelection(catalog, a)).toEqual({
      providerId: "a",
      modelId: "same-model",
    });
    expect(visibleSelection(catalog, b)).toEqual({
      providerId: "b",
      modelId: "same-model",
    });
    const file = providerFile(catalog, gateway);
    expect(
      file.config.providerConfigRules.providerRules.map(
        (rule) => rule.config.personalModelIds,
      ),
    ).toEqual([["same-model"], ["same-model"]]);
  });
  it("matches the Rust catalog contract without leaking the picker prefix into the gateway request", () => {
    const realCatalog: Catalog = {
      revision: 2,
      models: [
        {
          id: "lolicode/channel_a__glm",
          providerId: "lolicode",
          modelId: "channel_a__glm",
          name: "A · GLM",
          channelName: "A",
        },
        {
          id: "lolicode/channel_b__glm",
          providerId: "lolicode",
          modelId: "channel_b__glm",
          name: "B · GLM",
          channelName: "B",
        },
      ],
    };
    expect(nativeSelection(realCatalog, realCatalog.models[0].id).modelId).toBe(
      "channel_a__glm",
    );
    expect(nativeSelection(realCatalog, realCatalog.models[1].id).modelId).toBe(
      "channel_b__glm",
    );
    expect(
      providerFile(realCatalog, gateway).config.providerConfigRules
        .providerRules[0].config.personalModelIds,
    ).toEqual(["channel_a__glm", "channel_b__glm"]);
  });
  it("uses declared reasoning options and preserves unknown upstream metadata", () => {
    expect(modelConfig(catalog.models[0]).optionSpecs.reasoningLevel).toEqual({
      values: ["low", "high"],
      map: '{"reasoning_effort": reasoningLevel}',
    });
    expect(modelConfig(catalog.models[1]).optionSpecs.reasoningLevel.map).toBe(
      "{}",
    );
    expect(catalog.models[1].contextLimit).toBeUndefined();
    expect(catalog.models[1].reasoningEfforts).toBeUndefined();
  });
  it("projects native manual-model fields without registry-only capabilities or output mappings", () => {
    const manual = manualModelConfig(catalog.models[0]);
    expect(Object.keys(manual.properties).sort()).toEqual([
      "contextWindow",
      "inputFormat",
      "supportsJsonSchemaOutput",
      "supportsMidConversationSystem",
      "supportsNativeWebSearch",
    ]);
    expect(manual.properties.inputFormat).toEqual({
      supportsImage: false,
      supportsVideo: false,
      supportsPdf: false,
    });
    expect(manual.optionSpecs.maxOutputTokens).toEqual({ max: 4000 });
    expect(manual.optionSpecs.reasoningLevel).toEqual(
      modelConfig(catalog.models[0]).optionSpecs.reasoningLevel,
    );
    expect(modelConfig(catalog.models[0]).properties.supportsToolCall).toBe(
      true,
    );
    expect(modelConfig(catalog.models[0]).optionSpecs.maxOutputTokens.map).toBe(
      '{"max_tokens": maxOutputTokens}',
    );
  });
  it("lets native model mutations add membership and retains the actual generated provider binding", async () => {
    const added: string[] = [];
    const removed: string[] = [];
    const settings = {
      async createPersonalProvider() {
        return { providerId: "generated-native-id" };
      },
      async savePersonalProviderOverlay(
        id: string,
        overlay: Record<string, unknown>,
      ) {
        expect(id).toBe("generated-native-id");
        expect(overlay).not.toHaveProperty("personalModelIds");
        expect(overlay).not.toHaveProperty("modelOrder");
      },
      async addPersonalModel(
        id: string,
        modelId: string,
        config: ReturnType<typeof manualModelConfig>,
        recommended: boolean,
      ) {
        expect(id).toBe("generated-native-id");
        expect(added).not.toContain(modelId);
        expect(config).toEqual(manualModelConfig(catalog.models[0]));
        expect(recommended).toBe(false);
        added.push(modelId);
      },
      async deletePersonalProvider(id: string) {
        removed.push(id);
      },
    };
    const lease = await provisionRemoteCatalog(
      { providerSettingsService: settings },
      undefined,
      { ...catalog, models: [catalog.models[0]] },
      "http://127.0.0.1:1234/v1",
      "ephemeral-relay-fixture",
    );
    expect(added).toEqual(["same-model"]);
    await lease.dispose();
    expect(removed).toEqual(["generated-native-id"]);
  });
  it.each([
    "https://upstream.example/v1",
    "http://localhost:34567/v1",
    "http://127.0.0.1:34567/v1?key=secret",
    "http://user:secret@127.0.0.1:34567/v1",
  ])("rejects a non-private gateway lease: %s", (baseUrl) => {
    expect(() => validateGateway({ ...gateway, baseUrl })).toThrow();
  });
  it("maps Auto to Guarded and exposes native single-use approvals correctly", () => {
    expect(collaborationMode("auto")).toBe("guarded");
    expect(collaborationMode("full_access")).toBe("yolo");
    expect(() => collaborationMode("custom")).toThrow();
    const permission = permissionDto("zc:s", {
      interactionId: "danger",
      payload: {
        toolName: "Bash",
        summary: "Dangerous operation",
        detail: { input: { command: "git clean -fd" } },
        options: [{ kind: "allowOnce" }, { kind: "deny" }],
      },
    });
    expect(permission.approvalMode).toBe("user-once");
    expect(permission.toolInput).toEqual({ command: "git clean -fd" });
  });
  it("keeps the canonical submitted command ID in user history for lost-ACK reconciliation", () => {
    expect(
      rowMessages([
        {
          rowId: 7,
          kind: "userInput",
          sourceCommandId: "pre-submit-id",
          createdAt: 1,
          text: "change file",
        },
      ])[0].id,
    ).toBe("pre-submit-id");
  });
  it.each([
    { queue: { items: [{ dispatch: { state: "reserved" } }] } },
    { pendingCommands: [{ state: "accepted" }] },
    { subagents: { running: [{ status: "blocked" }] } },
    { backgroundWorks: [{ status: "resultPending" }] },
    { workflowRuns: { runs: [{ status: "pending" }] } },
  ])(
    "keeps background admissions busy even when the foreground is idle: %j",
    (state) => {
      expect(
        nativeSnapshotBusy({
          control: { phase: "completedSuccess", canStop: false },
          ...state,
        }),
      ).toBe(true);
      expect(
        nativeSnapshotBusy({
          control: { phase: "completedSuccess", canStop: false },
        }),
      ).toBe(false);
    },
  );
});
