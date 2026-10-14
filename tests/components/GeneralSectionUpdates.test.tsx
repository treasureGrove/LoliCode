import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { GeneralSection } from "@/components/settings/sections/GeneralSection";
import type { SettingsFormState } from "@/hooks/useSettings";

vi.mock("@/components/theme-provider", () => ({
  useTheme: () => ({ theme: "light", setTheme: vi.fn() }),
}));
vi.mock("@/components/settings/TerminalSettings", () => ({
  TerminalSelect: () => null,
}));

const defaults: SettingsFormState = {
  language: "zh",
  showInTray: true,
  minimizeToTrayOnClose: false,
};
describe("software update preference", () => {
  it("defaults to enabled and saves an explicit user opt out", () => {
    const save = vi.fn().mockResolvedValue(true);
    render(
      <GeneralSection
        settings={defaults}
        onAutoSave={save}
        onOpenApps={vi.fn()}
      />,
    );
    const toggle = screen.getByRole("switch", {
      name: "启动时检查 LoliCode 更新",
    });
    expect(toggle).toHaveAttribute("aria-checked", "true");
    fireEvent.click(toggle);
    expect(save).toHaveBeenCalledWith({ checkUpdates: false });
  });
  it("preserves an existing disabled app check independently of tool update checks", () => {
    const save = vi.fn().mockResolvedValue(true);
    render(
      <GeneralSection
        settings={{
          ...defaults,
          checkUpdates: false,
          checkToolUpdatesOnStartup: true,
        }}
        onAutoSave={save}
        onOpenApps={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("switch", { name: "启动时检查 LoliCode 更新" }),
    ).toHaveAttribute("aria-checked", "false");
    expect(
      screen.getByRole("switch", { name: "settings.general.checkToolUpdates" }),
    ).toHaveAttribute("aria-checked", "true");
    expect(save).not.toHaveBeenCalled();
  });
});
