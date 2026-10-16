/* Development-only visual fixture. This entry is not imported by src/main.tsx or the build. */
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AgentPage } from "../../../src/components/agent/AgentPage";
import { agentApi } from "../../../src/lib/api/agent";
import { agentFilesApi } from "../../../src/lib/api/agent-files";
import {
  ThemeProvider,
  useTheme,
} from "../../../src/components/theme-provider";
import { InterfaceAppearanceRoot } from "../../../src/components/shell/InterfaceAppearanceRoot";
import { InterfaceAppearanceSettings } from "../../../src/components/settings/InterfaceAppearanceSettings";
import { CopilotBillingPanel } from "../../../src/components/usage/CopilotBillingPanel";
import { AppPageHeader } from "../../../src/components/shell/AppPageHeader";
import {
  SettingsBlock,
  SettingsBody,
  SettingsCard,
  SettingsRow,
} from "../../../src/components/settings/SettingsLayout";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../../src/components/ui/dialog";
import { Button } from "../../../src/components/ui/button";
import { Input } from "../../../src/components/ui/input";
import { SegmentedControl } from "../../../src/components/ui/segmented-control";
import { TooltipProvider } from "../../../src/components/ui/tooltip";
import type {
  AgentCatalog,
  AgentSession,
  AgentSnapshot,
} from "../../../src/types/agent";
import "../../../src/i18n";
import "../../../src/index.css";
import "../../../src/styles/lolicode.css";

// Only fixture data is returned. This isolated browser page cannot call the real native backend.
const billingNow = new Date();
const billingFixture = {
  accountLogin: "example-personal",
  year: billingNow.getFullYear(),
  month: billingNow.getMonth() + 1,
  kind: "ai_credits",
  fetchedAt: Math.floor(billingNow.getTime() / 1000),
  source: "github-billing-api",
  items: [
    {
      product: "Copilot AI Credits",
      sku: "AI Credit",
      model: "示例模型 A",
      unitType: "ai-credits",
      pricePerUnit: 0.01,
      grossQuantity: 1350.25,
      grossAmount: 13.5025,
      discountQuantity: 1000,
      discountAmount: 10,
      netQuantity: 350.25,
      netAmount: 3.5025,
    },
  ],
};
const billingAccount = {
  id: "qa-personal",
  login: "example-personal",
  avatar_url: null,
  authenticated_at: 0,
  github_domain: "github.com",
};
Object.assign(window, {
  __TAURI_INTERNALS__: {
    invoke: async (command: string) => {
      if (command === "copilot_list_accounts") return [billingAccount];
      if (command === "copilot_get_auth_status")
        return {
          authenticated: true,
          default_account_id: "qa-personal",
          accounts: [billingAccount],
          username: billingAccount.login,
          expires_at: null,
        };
      if (command === "copilot_billing_list_reports") return [billingFixture];
      if (command === "copilot_billing_sync")
        throw new Error("示例页不连接 GitHub，请在桌面应用内同步真实账单。");
      return null;
    },
    transformCallback: () => 1,
    unregisterCallback: () => {},
    metadata: {
      currentWindow: { label: "qa" },
      currentWebview: { label: "qa" },
    },
  },
});
const project = "D:/examples/星图工坊";
const catalog: AgentCatalog = {
  revision: 1,
  defaultModel: "qa/flash",
  excludedSources: [],
  models: [
    {
      id: "qa/flash",
      providerId: "qa",
      modelId: "flash",
      name: "DeepSeek Flash",
      channelName: "示例渠道",
      contextLimit: 1000000,
      outputLimit: 64000,
      reasoningEfforts: ["low", "medium", "high", "max"],
      reasoningEffortSource: "示例目录",
      reasoningEffortTransport: "declared",
    },
    {
      id: "qa/pro",
      providerId: "qa",
      modelId: "pro",
      name: "Code Pro",
      channelName: "示例渠道",
      reasoningEfforts: ["low", "high"],
    },
  ],
};
const session: AgentSession = {
  id: "lc:qa",
  title: "浏览器里的黑洞小实验",
  projectPath: project,
  model: { providerId: "qa", modelId: "flash" },
  mode: "build",
  permissionMode: "ask",
  reasoningEffort: "high",
  createdAt: Date.now(),
  updatedAt: Date.now(),
  pinned: true,
};
const snapshot: AgentSnapshot = {
  session,
  status: "idle",
  streamConnected: true,
  permissions: [],
  questions: [],
  messages: [
    {
      id: "u1",
      role: "user",
      createdAt: 1,
      parts: [
        {
          type: "text",
          text: "做一个浏览器里的黑洞小实验，光线柔和一点，能交互调整吸积盘。",
        },
      ],
    },
    {
      id: "a1",
      role: "assistant",
      createdAt: 2,
      parts: [
        {
          type: "reasoning",
          text: "先检查项目结构，再确认已有渲染组件与交互入口。",
        },
        {
          type: "tool",
          id: "t1",
          name: "read_file",
          state: "completed",
          input: { path: "src/BlackHole.tsx" },
          output: "已读取组件。",
        },
        {
          type: "tool",
          id: "t2",
          name: "edit_file",
          state: "completed",
          input: { path: "src/BlackHole.tsx" },
          output: "已调整渲染参数。",
        },
        {
          type: "text",
          text: "吸积盘和透镜效果已经分开整理。\n\n- 用轻量着色器表达光线弯曲\n- 参数面板支持调整旋转速度与亮度\n- 保持鼠标缩放和拖动交互\n\n```ts\nconst appearance = {\n  bloom: 0.24,\n  diskSpeed: 0.6,\n  exposure: 0.8,\n};\n```\n\n接下来可以打开预览，看看星光和边缘亮度是否合适。",
        },
      ],
    },
  ],
  diffs: [
    {
      path: "src/BlackHole.tsx",
      patch: "@@ -1 +1 @@\n-const bloom = 1;\n+const bloom = 0.24;",
      additions: 14,
      deletions: 6,
      status: "modified",
    },
  ],
  usage: {
    session: {
      since: Date.now(),
      complete: true,
      modelRequests: 6,
      reportedRequests: 6,
      inputTokens: 18240,
      outputTokens: 2100,
      cacheReadTokens: 15200,
      cacheHitRate: 0.83,
    },
  },
};
agentApi.getStatus = async () => ({
  available: true,
  running: true,
  projectPath: project,
});
agentApi.getCatalog = async () => structuredClone(catalog);
agentApi.getCatalogRevision = async () => 1;
agentApi.listProjects = async () => [
  { path: project, name: "星图工坊", pinned: true, lastOpenedAt: 1 },
];
agentApi.listSessions = async () => [structuredClone(session)];
agentApi.getSession = async () => structuredClone(snapshot);
agentApi.updateSession = async (_id, patch) => {
  if (patch.modelId) {
    const model = catalog.models.find((m) => m.id === patch.modelId)!;
    session.model = { providerId: model.providerId, modelId: model.modelId };
  }
  Object.assign(session, {
    ...(patch.permissionMode && { permissionMode: patch.permissionMode }),
    ...(patch.reasoningEffort !== undefined && {
      reasoningEffort: patch.reasoningEffort,
    }),
  });
  return structuredClone(session);
};
agentApi.getExtensions = async () => ({
  revision: 1,
  skills: [
    {
      id: "qa-3d",
      name: "前端 3D",
      description: "视觉验收用的技能卡片。",
      source: "bundled",
      installed: true,
      enabled: true,
      requirements: [],
    },
  ],
  plugins: [],
  mcpServers: [],
});
agentApi.sendMessage = async () => {
  throw new Error("此页面仅用于视觉验收，不发送模型请求。");
};
agentApi.setProjectMetadata = async (_path, pinned) => ({
  path: project,
  name: "星图工坊",
  pinned,
  lastOpenedAt: 1,
});
agentApi.removeProject = async () => {};
agentFilesApi.preview = async (_sessionId, path) => ({
  kind: "html",
  path,
  name: "starlight.html",
  mimeType: "text/html",
  truncated: false,
  sizeBytes: 1200,
  content: `<style>body{margin:0;background:#121b2b;color:#f0e4c9;font-family:Georgia,serif;display:grid;min-height:100vh;place-items:center}.scene{text-align:center;padding:30px}h1{font-size:28px;font-weight:400;letter-spacing:2px}.orbit{width:180px;height:180px;border:1px solid #bca67b;border-radius:50%;display:grid;place-items:center;margin:25px auto;background:radial-gradient(circle,#263d52 20%,#192a3b 22%,#192a3b 48%,#121b2b 49%)}.star{color:#cbb683;font-size:48px}.caption{font-size:11px;letter-spacing:3px;color:#96a9bc}</style><div class="scene"><p class="caption">示例作品 · 静态预览</p><h1>星光与轨道</h1><div class="orbit"><span class="star">✧</span></div><p class="caption">温柔的光，安静的创作</p></div>`,
});
agentFilesApi.open = async () => {};

function QA() {
  const [view, setView] = useState("agent");
  const [dialog, setDialog] = useState(false);
  const { theme, setTheme } = useTheme();
  return (
    <>
      <InterfaceAppearanceRoot />
      <div
        style={{
          height: 28,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          padding: "0 12px",
          background: "var(--bg-card)",
          color: "var(--text-3)",
          borderBottom: "1px solid var(--atelier-line)",
          fontSize: 10,
        }}
      >
        <span>开发组件验收 · 示例数据 · 不调用模型／GitHub</span>
        <div style={{ display: "flex", gap: 16 }}>
          <button onClick={() => setView("agent")}>工作台</button>
          <button onClick={() => setView("settings")}>设置样式</button>
          <button onClick={() => setView("billing")}>账单样式</button>
          <button onClick={() => setDialog(true)}>弹窗样式</button>
          <button onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
            切换明暗
          </button>
        </div>
      </div>
      <div
        className="tai-shell flex overflow-hidden text-fg-1"
        style={{ height: "calc(100dvh - 28px)" }}
      >
        <main
          data-view={view}
          className="tai-main relative isolate flex min-w-0 flex-1 flex-col overflow-hidden"
        >
          {view === "agent" ? (
            <AgentPage onOpenChannels={() => setView("settings")} />
          ) : view === "billing" ? (
            <>
              <AppPageHeader
                title="Copilot 账单样式"
                subtitle="示例数据 · 不连接 GitHub"
              />
              <div className="min-h-0 flex-1 overflow-y-auto">
                <SettingsBody>
                  <CopilotBillingPanel />
                </SettingsBody>
              </div>
            </>
          ) : (
            <>
              <AppPageHeader
                title="通用设置"
                subtitle="视觉验收 · 使用实际设置组件"
              />
              <div className="min-h-0 flex-1 overflow-y-auto">
                <SettingsBody>
                  <SettingsBlock title="外观">
                    <SettingsCard>
                      <SettingsRow
                        label="主题"
                        control={
                          <SegmentedControl
                            size="sm"
                            aria-label="主题"
                            value={theme}
                            onValueChange={setTheme}
                            items={[
                              { value: "light", label: "浅色" },
                              { value: "dark", label: "深色" },
                            ]}
                          />
                        }
                      />
                      <InterfaceAppearanceSettings />
                    </SettingsCard>
                  </SettingsBlock>
                  <SettingsBlock title="输入与操作">
                    <SettingsCard>
                      <SettingsRow
                        label="工作区名称"
                        control={
                          <Input
                            aria-label="工作区名称"
                            defaultValue="星图工坊"
                          />
                        }
                      />
                      <SettingsRow
                        label="配置管理"
                        control={
                          <Button
                            onClick={() => setDialog(true)}
                            variant="outline"
                          >
                            打开配置面板
                          </Button>
                        }
                      />
                    </SettingsCard>
                  </SettingsBlock>
                </SettingsBody>
              </div>
            </>
          )}
        </main>
      </div>
      <Dialog open={dialog} onOpenChange={setDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>模型与渠道</DialogTitle>
            <DialogDescription>
              服饰配色与细金边保持统一，表单优先清晰。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 px-6 py-5">
            <label className="block text-sm">
              显示名称
              <Input className="mt-2" defaultValue="创作工作区" />
            </label>
            <label className="block text-sm">
              服务地址
              <Input className="mt-2" placeholder="https://example.com/v1" />
            </label>
          </div>
          <DialogFooter>
            <Button variant="quiet" onClick={() => setDialog(false)}>
              取消
            </Button>
            <Button onClick={() => setDialog(false)}>完成</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={new QueryClient()}>
    <ThemeProvider defaultTheme="dark" storageKey="lolicode.atelier-qa.theme">
      <TooltipProvider>
        <QA />
      </TooltipProvider>
    </ThemeProvider>
  </QueryClientProvider>,
);
