import { useCallback, useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "@/lib/toast";
import { modelsDevQueryOptions, type ModelsDevResponse } from "@/lib/modelsDev";
import {
  resolveModelMetadata,
  type ModelMetadataSource,
  type PresetModelSource,
  type ResolvedModelMetadata,
} from "@/lib/modelMetadata";
import { useLatestRef } from "./useLatestRef";
import type { FetchedModel } from "@/lib/api/model-fetch";

const FILLED_TOAST_ID = "model-metadata-filled";

/**
 * 表单从拉取列表里选中模型后，调 `fill(modelId, apply)` 补这一行空着的参数。
 *
 * `apply(metadata)` 把参数补进当时仍是这个模型的那一行并提交，返回是否真的改动
 * 了字段。它会被调用最多两次：当场一次（同地址预设 + 已缓存的 models.dev），
 * models.dev 数据晚到时再一次，所以调用方先提交「改模型 ID」，`apply` 读最新的
 * 行、确认模型没被用户改掉、只补空字段。有改动时由这里提示用户核对；同一轮里
 * 补了几个模型（批量添加、两次先后到达）只合并成一条提示。从选择弹窗加入的模型
 * 传 `silent`：弹窗里已经显示过这些参数，不再提示。
 *
 * `prefetch` 为真（已经拉过模型列表）时提前下载 models.dev，和价格导入共用同
 * 一份查询缓存；离线或下载失败时只用预设里的值，不打扰用户。
 */
export function useModelMetadataFill({
  baseUrl,
  presets,
  prefetch,
  fetchCatalog,
  catalogScope,
  catalogModels,
}: {
  baseUrl: string;
  presets: () => readonly PresetModelSource[];
  prefetch: boolean;
  /** Read-only directory request; never an inference/paid test. */
  fetchCatalog?: () => Promise<FetchedModel[]>;
  /** In-memory identity includes endpoint/account/credentials; never logged or persisted. */
  catalogScope?: string;
  /** A directory already fetched for this exact scope, including an empty result. */
  catalogModels?: readonly FetchedModel[];
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  // 只下载不订阅：表单不读这份数据，数据到了也不必重渲染。
  useEffect(() => {
    if (prefetch) void queryClient.prefetchQuery(modelsDevQueryOptions);
  }, [prefetch, queryClient]);

  const baseUrlRef = useLatestRef(baseUrl);
  const presetsRef = useLatestRef(presets);
  const fetchCatalogRef = useLatestRef(fetchCatalog);
  const catalogScopeRef = useLatestRef(catalogScope);
  const catalogModelsRef = useLatestRef(catalogModels);
  const alive = useRef(true);
  const upstreamCache = useRef<{
    scope: string | undefined;
    endpoint: string;
    expires: number;
    promise: Promise<FetchedModel[]>;
  }>();
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      upstreamCache.current = undefined;
    };
  }, []);

  const pending = useRef<{
    models: Set<string>;
    sources: Set<ModelMetadataSource>;
    timer?: ReturnType<typeof setTimeout>;
  }>({ models: new Set(), sources: new Set() });
  useEffect(() => () => clearTimeout(pending.current.timer), []);

  const notify = useCallback(
    (modelId: string, sources: readonly ModelMetadataSource[]) => {
      const batch = pending.current;
      batch.models.add(modelId);
      for (const source of sources) batch.sources.add(source);
      clearTimeout(batch.timer);
      batch.timer = setTimeout(() => {
        const models = [...batch.models];
        const fromPreset = batch.sources.has("preset");
        const fromModelsDev = batch.sources.has("models-dev");
        const fromUpstream = batch.sources.has("upstream");
        batch.models.clear();
        batch.sources.clear();
        const source = fromUpstream
          ? t("providerForm.modelMetadataSourceUpstream", {
              defaultValue: "上游模型目录",
            })
          : fromPreset && fromModelsDev
            ? t("providerForm.modelMetadataSourceBoth", {
                defaultValue: "预设和 models.dev",
              })
            : fromPreset
              ? t("providerForm.modelMetadataSourcePreset", {
                  defaultValue: "预设",
                })
              : "models.dev";
        toast.info(
          models.length === 1
            ? t("providerForm.modelMetadataFilled", {
                model: models[0],
                source,
                defaultValue:
                  "已补全 {{model}} 的上下文等参数（来源：{{source}}），请核对",
              })
            : t("providerForm.modelMetadataFilledMany", {
                count: models.length,
                source,
                defaultValue:
                  "已补全 {{count}} 个模型的上下文等参数（来源：{{source}}），请核对",
              }),
          { id: FILLED_TOAST_ID },
        );
      }, 50);
    },
    [t],
  );

  return useCallback(
    (
      modelId: string,
      apply: (metadata: ResolvedModelMetadata) => boolean,
      options?: {
        /** 这一行实际请求的地址（模型级覆盖时传入），默认用表单的地址。 */
        baseUrl?: string;
        silent?: boolean;
      },
    ): void => {
      const id = modelId.trim();
      if (!id) return;
      const endpoint = baseUrlRef.current;
      const scope = catalogScopeRef.current;
      const stillCurrent = () =>
        alive.current &&
        baseUrlRef.current === endpoint &&
        catalogScopeRef.current === scope;
      let upstream: FetchedModel | undefined;
      const resolve = (modelsDev?: ModelsDevResponse) =>
        resolveModelMetadata(id, {
          baseUrl: options?.baseUrl || baseUrlRef.current,
          presets: presetsRef.current(),
          modelsDev,
        });
      const run = (metadata: ResolvedModelMetadata | null) => {
        if (!stillCurrent()) return;
        const declared: Partial<ResolvedModelMetadata> = {};
        if (
          upstream?.contextLimit &&
          Number.isSafeInteger(upstream.contextLimit) &&
          upstream.contextLimit > 0
        )
          declared.contextWindow = upstream.contextLimit;
        if (
          upstream?.outputLimit &&
          Number.isSafeInteger(upstream.outputLimit) &&
          upstream.outputLimit > 0
        )
          declared.maxOutputTokens = upstream.outputLimit;
        if (upstream?.reasoningEfforts)
          declared.reasoningEfforts = [...upstream.reasoningEfforts];
        if (upstream?.reasoningEfforts?.length) declared.reasoning = true;
        const combined = Object.keys(declared).length
          ? {
              ...metadata,
              ...declared,
              sources: ["upstream" as const, ...(metadata?.sources ?? [])],
            }
          : metadata;
        if (combined && apply(combined) && !options?.silent) {
          notify(id, combined.sources);
        }
      };
      const fillKnown = () => {
        if (!stillCurrent()) return;
        const cached = queryClient.getQueryData(modelsDevQueryOptions.queryKey);
        run(resolve(cached));
        if (!cached)
          queryClient
            .fetchQuery(modelsDevQueryOptions)
            .then((data) => run(resolve(data)))
            .catch(() => {});
      };
      // A row with an endpoint override must never receive another endpoint's
      // model metadata or credentials. Its preset/public fallback stays scoped.
      if (options?.baseUrl && options.baseUrl !== endpoint) {
        fillKnown();
        return;
      }
      if (catalogModelsRef.current) {
        upstream = catalogModelsRef.current.find((model) => model.id === id);
        fillKnown();
        return;
      }
      if (!fetchCatalogRef.current) {
        fillKnown();
        return;
      }
      let cached = upstreamCache.current;
      if (
        !cached ||
        cached.scope !== scope ||
        cached.endpoint !== endpoint ||
        cached.expires < Date.now()
      ) {
        const entry = {
          scope,
          endpoint,
          expires: Date.now() + 300_000,
          promise: Promise.resolve([] as FetchedModel[]),
        };
        entry.promise = Promise.resolve()
          .then(() => (stillCurrent() ? fetchCatalogRef.current!() : []))
          .catch(() => {
            // Read-only catalog failure is non-blocking. Do not expose endpoint,
            // headers or credentials through native error text or toasts.
            entry.expires = Date.now() + 20_000;
            return [];
          });
        upstreamCache.current = cached = entry;
      }
      cached.promise.then((models) => {
        if (!stillCurrent()) return;
        upstream = models.find((model) => model.id === id);
        fillKnown();
      });
    },
    [
      baseUrlRef,
      catalogModelsRef,
      catalogScopeRef,
      fetchCatalogRef,
      notify,
      presetsRef,
      queryClient,
    ],
  );
}
