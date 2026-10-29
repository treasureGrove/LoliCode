import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AboutSection } from "@/features/settings/AboutSection";
import { AppPageHeader } from "@/app/shell/AppPageHeader";

const buildState = vi.hoisted(() => ({ development: true, dirty: true }));
const nativeBuild = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: nativeBuild.invoke }));
vi.mock("@/lib/buildChannel", () => ({
  get IS_DEVELOPMENT_BUILD() {
    return buildState.development;
  },
  BUILD_CHANNEL: "development",
  BUILD_NUMBER: "DEV-20261028-174243",
  BUILD_REVISION: "abc1234+dirty",
  BUILD_BRANCH: "TG/freehub-m0",
  BUILD_TIMESTAMP: "2026-10-28T09:42:43.000Z",
  get BUILD_DIRTY() {
    return buildState.dirty;
  },
  buildChannelLabel: () => (buildState.development ? "开发版" : "正式版"),
}));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: async () => "4.1.3" }));
vi.mock("@/contexts/UpdateContext", () => ({
  useUpdate: () => ({
    hasUpdate: false,
    updateInfo: null,
    isChecking: false,
    isInstalling: false,
    phase: "idle",
    progress: null,
    error: null,
    checkUpdate: vi.fn(),
    installUpdate: vi.fn(),
    resetDismiss: vi.fn(),
  }),
}));
vi.mock("@/components/WhatsNewDialog", () => ({ WhatsNewDialog: () => null }));
vi.mock("@/features/settings/ResourceUpdatesSection", () => ({
  ResourceUpdatesSection: () => <div>Stable resource updates</div>,
}));
vi.mock("@/features/settings/RendererUpdatesSection", () => ({
  RendererUpdatesSection: () => <div>Stable renderer updates</div>,
}));

describe("development application identity", () => {
  beforeEach(() => {
    buildState.development = true;
    buildState.dirty = true;
    nativeBuild.invoke.mockResolvedValue({
      developmentBuildNumber: "DEV-20261027-100000",
      sourceBranch: "TG/native-build",
      sourceRevision: "def5678",
    });
  });
  it("labels every page header while leaving the page heading readable", () => {
    render(<AppPageHeader title="项目" />);
    expect(screen.getByRole("heading", { name: "项目" })).toBeInTheDocument();
    expect(
      screen
        .getByText("开发版 · DEV-20261028-174243")
        .closest("[data-build-channel]"),
    ).toHaveAttribute("data-build-channel", "development");
    expect(screen.getByText("TG/freehub-m0")).toBeVisible();
    expect(
      screen.getByText("TG/freehub-m0").closest("[title]"),
    ).toHaveAttribute("title", "构建分支：TG/freehub-m0 · 含未提交改动");
  });

  it("shows the source revision and rebuild instructions without stable update controls", async () => {
    render(<AboutSection isPortable={false} />);
    expect(await screen.findByText("LoliCode 开发版")).toBeInTheDocument();
    expect(screen.getByText("abc1234+dirty")).toBeInTheDocument();
    expect(screen.getByText("DEV-20261028-174243")).toBeInTheDocument();
    expect(screen.getByText("界面开发号：")).toBeInTheDocument();
    expect(screen.getByText("构建分支：")).toBeInTheDocument();
    expect(screen.getByText("构建时工作区：含未提交改动")).toBeInTheDocument();
    expect(
      document.querySelector('time[datetime="2026-10-28T09:42:43.000Z"]'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "开发版 · 本地构建更新" }),
    ).toBeDisabled();
    expect(screen.getByText(/后端改动运行 pnpm build:dev/)).toBeInTheDocument();
    expect(
      screen.queryByText("Stable resource updates"),
    ).not.toBeInTheDocument();
    expect(await screen.findByText("DEV-20261027-100000")).toBeInTheDocument();
    expect(screen.getByText("原生开发号：")).toBeInTheDocument();
    expect(screen.getByText("TG/native-build · def5678")).toBeInTheDocument();
    expect(
      screen.queryByText("Stable renderer updates"),
    ).not.toBeInTheDocument();
  });

  it("distinguishes a clean source snapshot", async () => {
    buildState.dirty = false;
    render(<AboutSection isPortable={false} />);
    await screen.findByText("DEV-20261027-100000");
    expect(screen.getByText("构建时工作区：无未提交改动")).toBeInTheDocument();
    expect(
      screen.queryByText("构建时工作区：含未提交改动"),
    ).not.toBeInTheDocument();
  });

  it("does not expose development source metadata in stable builds", () => {
    buildState.development = false;
    render(<AboutSection isPortable={false} />);
    expect(screen.queryByText("TG/freehub-m0")).not.toBeInTheDocument();
    expect(screen.queryByText("DEV-20261028-174243")).not.toBeInTheDocument();
    expect(screen.queryByText("abc1234+dirty")).not.toBeInTheDocument();
    expect(screen.queryByText("构建时工作区：")).not.toBeInTheDocument();
    expect(document.querySelector("time")).not.toBeInTheDocument();
    expect(nativeBuild.invoke).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("button", { name: "热更新界面" }),
    ).not.toBeInTheDocument();
  });

  it("keeps About usable when an older native build has no source metadata", async () => {
    nativeBuild.invoke.mockResolvedValue({ channel: "development" });
    render(<AboutSection isPortable={false} />);
    expect(await screen.findByText("LoliCode 开发版")).toBeInTheDocument();
    expect(screen.queryByText("原生开发号：")).not.toBeInTheDocument();
  });
});
