import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AboutSection } from "@/components/settings/AboutSection";
import { AppPageHeader } from "@/components/shell/AppPageHeader";

vi.mock("@/lib/buildChannel", () => ({
  IS_DEVELOPMENT_BUILD: true,
  BUILD_CHANNEL: "development",
  BUILD_NUMBER: "DEV-20261028-174243",
  BUILD_REVISION: "abc1234+dirty",
  buildChannelLabel: () => "开发版",
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
vi.mock("@/components/settings/ResourceUpdatesSection", () => ({
  ResourceUpdatesSection: () => <div>Stable resource updates</div>,
}));
vi.mock("@/components/settings/RendererUpdatesSection", () => ({
  RendererUpdatesSection: () => <div>Stable renderer updates</div>,
}));

describe("development application identity", () => {
  it("labels every page header while leaving the page heading readable", () => {
    render(<AppPageHeader title="项目" />);
    expect(screen.getByRole("heading", { name: "项目" })).toBeInTheDocument();
    expect(
      screen
        .getByText("开发版 · DEV-20261028-174243")
        .closest("[data-build-channel]"),
    ).toHaveAttribute("data-build-channel", "development");
  });

  it("shows the source revision and rebuild instructions without stable update controls", async () => {
    render(<AboutSection isPortable={false} />);
    expect(await screen.findByText("LoliCode 开发版")).toBeInTheDocument();
    expect(screen.getByText("abc1234+dirty")).toBeInTheDocument();
    expect(screen.getByText("DEV-20261028-174243")).toBeInTheDocument();
    expect(screen.getByText("开发号：")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "开发版 · 本地构建更新" }),
    ).toBeDisabled();
    expect(screen.getByText(/运行 pnpm build:dev/)).toBeInTheDocument();
    expect(
      screen.queryByText("Stable resource updates"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("Stable renderer updates"),
    ).not.toBeInTheDocument();
  });
});
