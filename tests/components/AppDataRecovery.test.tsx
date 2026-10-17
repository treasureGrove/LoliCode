import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppDataRecovery } from "@/components/AppDataRecovery";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  open: vi.fn(),
  relaunch: vi.fn(),
  exit: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: mocks.open }));
vi.mock("@tauri-apps/plugin-process", () => ({
  relaunch: mocks.relaunch,
  exit: mocks.exit,
}));

describe("data directory recovery", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("explains invalid path configuration and restarts only after recovery succeeds", async () => {
    mocks.open.mockResolvedValue("D:/original-profile");
    mocks.invoke.mockResolvedValue(true);
    render(
      <AppDataRecovery
        path="app_paths.json"
        error="invalid config"
        invalidConfiguration
      />,
    );
    expect(
      screen.getByRole("heading", { name: "无法读取数据目录配置" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/选择后会先备份当前路径配置文件/),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "选择原数据目录并重启" }),
    );
    await waitFor(() => expect(mocks.relaunch).toHaveBeenCalledOnce());
    expect(mocks.invoke).toHaveBeenCalledWith("recover_app_config_dir", {
      path: "D:/original-profile",
    });
    expect(mocks.relaunch.mock.invocationCallOrder[0]).toBeGreaterThan(
      mocks.invoke.mock.invocationCallOrder[0],
    );
  });

  it("keeps the recovery screen and allows retry when saving the backup fails", async () => {
    mocks.open.mockResolvedValue("D:/original-profile");
    mocks.invoke.mockRejectedValue(new Error("无法备份路径配置"));
    render(
      <AppDataRecovery
        path="app_paths.json"
        error="invalid config"
        invalidConfiguration
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "选择原数据目录并重启" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "无法备份路径配置",
    );
    expect(mocks.relaunch).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "选择原数据目录并重启" }),
    ).toBeEnabled();
  });

  it("does not change configuration if directory selection is cancelled", async () => {
    mocks.open.mockResolvedValue(null);
    render(<AppDataRecovery path="D:/missing" error="volume unavailable" />);
    expect(
      screen.getByRole("heading", { name: "找不到原来的数据目录" }),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "选择原数据目录并重启" }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "选择原数据目录并重启" }),
      ).toBeEnabled(),
    );
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(mocks.relaunch).not.toHaveBeenCalled();
  });
});
