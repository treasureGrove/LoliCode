import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { open } from "@tauri-apps/plugin-dialog";
import { Download, FolderOpen, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  CHANNEL_TARGET_NAMES,
  ChannelTargetGlyph,
} from "@/components/channels/channelTargets";
import {
  LOCAL_AGENT_IDS,
  LOCAL_AGENT_DOWNLOADS,
  localAgentToolsApi,
  type LocalAgentId,
  type AutoConfigLocalAgentId,
} from "@/lib/api/local-agent-tools";
import { settingsApi } from "@/lib/api/settings";

export const LOCAL_AGENT_TOOLS_QUERY_KEY = ["local-agent-tools"];
const localAgentName = (id: LocalAgentId) =>
  id === "qoder" ? "Qoder" : CHANNEL_TARGET_NAMES[id];

export function LocalAgentTools({
  onConfigure,
  configureDisabled = false,
}: {
  onConfigure?: (target: AutoConfigLocalAgentId) => void;
  configureDisabled?: boolean;
}) {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: LOCAL_AGENT_TOOLS_QUERY_KEY,
    queryFn: localAgentToolsApi.list,
    staleTime: 30_000,
    retry: false,
  });
  const [busy, setBusy] = useState<LocalAgentId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [qoderGuideOpen, setQoderGuideOpen] = useState(false);

  const run = async (id: LocalAgentId, action: () => Promise<unknown>) => {
    setBusy(id);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(`${localAgentName(id)}：${String(e)}`);
    } finally {
      setBusy(null);
    }
  };
  const choose = async (id: LocalAgentId) => {
    const path = await open({
      title: `选择 ${localAgentName(id)} 的已安装程序`,
      multiple: false,
      directory: false,
    });
    if (typeof path !== "string") return;
    await localAgentToolsApi.setPath(id, path);
    await client.invalidateQueries({ queryKey: LOCAL_AGENT_TOOLS_QUERY_KEY });
  };

  return (
    <section aria-label="国产 Agent 工具" className="mb-5">
      <div className="mb-2 flex items-center justify-between gap-2 px-1">
        <h3 className="text-body font-medium text-fg-1">
          桌面 Agent 与 MiMo Code
        </h3>
        <Button
          size="compact"
          variant="quiet"
          disabled={query.isFetching || Boolean(busy)}
          onClick={() => void query.refetch()}
        >
          <RefreshCw
            className={`h-3.5 w-3.5 ${query.isFetching ? "animate-spin" : ""}`}
          />
          重新检测
        </Button>
      </div>
      {query.isError && (
        <p role="alert" className="mb-2 text-caption text-red-500">
          无法检测本地 Agent：{String(query.error)}。请重试。
        </p>
      )}
      {error && (
        <p role="alert" className="mb-2 text-caption text-red-500">
          {error}
        </p>
      )}
      <div className="divide-y divide-border rounded-panel border border-border bg-surface">
        {LOCAL_AGENT_IDS.map((id) => {
          const tool = query.data?.find((tool) => tool.id === id);
          const installed = tool?.installed === true;
          return (
            <div key={id} data-local-agent={id} className="px-4 py-3">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <ChannelTargetGlyph app={id} />
                <div className="min-w-0 flex-1 basis-40">
                  <div className="flex flex-wrap items-center gap-2 text-body font-medium text-fg-1">
                    {localAgentName(id)}
                    <span className="text-caption font-normal text-fg-3">
                      {query.isPending
                        ? "检测中…"
                        : !tool
                          ? "状态未知"
                          : installed
                            ? tool.version || "已安装"
                            : tool.customPath
                              ? "程序位置已失效"
                              : "未检测到程序"}
                    </span>
                  </div>
                  {tool?.path && (
                    <p
                      title={tool.path}
                      className="mt-1 truncate text-caption text-fg-3"
                    >
                      {tool.path}
                    </p>
                  )}
                  {tool && (
                    <p
                      title={tool.configPaths.join("\n")}
                      className="mt-1 text-caption text-fg-3"
                    >
                      {id === "qoder"
                        ? "通过 Qoder 官方设置向导添加模型"
                        : tool.configError ||
                          (tool.configExists
                            ? "已发现配置文件"
                            : "尚未发现模型配置")}
                    </p>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  {busy === id && (
                    <Loader2
                      aria-label="处理中"
                      className="h-3.5 w-3.5 animate-spin"
                    />
                  )}
                  {installed && (
                    <Button
                      size="compact"
                      variant="quiet"
                      disabled={Boolean(busy)}
                      onClick={() =>
                        void run(id, () => localAgentToolsApi.reveal(id))
                      }
                    >
                      <FolderOpen className="h-3.5 w-3.5" />
                      打开位置
                    </Button>
                  )}
                  <Button
                    size="compact"
                    variant="quiet"
                    disabled={Boolean(busy)}
                    onClick={() => void run(id, () => choose(id))}
                  >
                    选择程序
                  </Button>
                  {tool?.customPath && (
                    <Button
                      size="compact"
                      variant="quiet"
                      disabled={Boolean(busy)}
                      onClick={() =>
                        void run(id, async () => {
                          await localAgentToolsApi.setPath(id, null);
                          await client.invalidateQueries({
                            queryKey: LOCAL_AGENT_TOOLS_QUERY_KEY,
                          });
                        })
                      }
                    >
                      自动检测
                    </Button>
                  )}
                  <Button
                    size="compact"
                    variant="neutral"
                    disabled={Boolean(busy)}
                    onClick={() =>
                      void run(id, () =>
                        settingsApi.openExternal(LOCAL_AGENT_DOWNLOADS[id]),
                      )
                    }
                  >
                    <Download className="h-3.5 w-3.5" />
                    {installed ? "官网下载／更新" : "官网下载"}
                  </Button>
                  {id === "qoder" ? (
                    <Button
                      size="compact"
                      variant="neutral"
                      disabled={Boolean(busy)}
                      onClick={() => setQoderGuideOpen(true)}
                    >
                      模型设置指引
                    </Button>
                  ) : (
                    onConfigure && (
                      <Button
                        size="compact"
                        variant="neutral"
                        disabled={configureDisabled || Boolean(busy)}
                        onClick={() => onConfigure(id)}
                      >
                        配置模型
                      </Button>
                    )
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      <Dialog open={qoderGuideOpen} onOpenChange={setQoderGuideOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Qoder 模型设置</DialogTitle>
            <DialogDescription>
              在 Qoder 中验证并保存模型，完成后即可在对话中选择。
            </DialogDescription>
          </DialogHeader>
          <ol className="list-decimal space-y-3 px-8 py-3 text-body text-fg-2">
            <li>打开 Qoder 设置 → Models（模型），点击添加模型。</li>
            <li>
              选择供应商；使用中转时，选择 OpenAI Compatible 或 Anthropic
              Compatible，并确认 Chat Completions／Responses 接口类型。
            </li>
            <li>
              填写对应渠道的 API 地址、API Key 和模型
              ID，再按上游能力设置上下文、图片输入及思考档位。
            </li>
            <li>点击验证并添加，通过后在 Qoder 对话中选择此模型。</li>
          </ol>
          <p className="px-6 text-caption text-fg-3">
            此方式直接使用你在 Qoder 中填写的渠道；当前不会自动归入 LoliCode
            路由用量。
          </p>
          <DialogFooter>
            <Button
              variant="neutral"
              size="compact"
              disabled={Boolean(busy)}
              onClick={() =>
                void run("qoder", () =>
                  settingsApi.openExternal(
                    "https://docs.qoder.com/zh/qoder/custom-models",
                  ),
                )
              }
            >
              打开官方配置文档
            </Button>
            <Button
              variant="solid"
              size="compact"
              onClick={() => setQoderGuideOpen(false)}
            >
              知道了
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
