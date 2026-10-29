import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InterfaceAppearanceRoot } from "@/app/shell/InterfaceAppearanceRoot";
import { InterfaceAppearanceSettings } from "@/features/settings/InterfaceAppearanceSettings";
import { AgentCompanion } from "@/features/agent/AgentCompanion";
import {
  DEFAULT_INTERFACE_APPEARANCE,
  INTERFACE_APPEARANCE_KEY,
  parseInterfaceAppearance,
  saveInterfaceAppearance,
} from "@/lib/interfaceAppearance";

beforeEach(() => localStorage.removeItem(INTERFACE_APPEARANCE_KEY));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  saveInterfaceAppearance(DEFAULT_INTERFACE_APPEARANCE);
  localStorage.removeItem(INTERFACE_APPEARANCE_KEY);
  delete document.documentElement.dataset.decoration;
  document.documentElement.style.removeProperty("--atelier-intensity");
  document.documentElement.style.removeProperty("--interface-font-scale");
});

describe("interface appearance", () => {
  it("recovers malformed preferences and bounds saved intensity", () => {
    expect(parseInterfaceAppearance("{broken")).toEqual(
      DEFAULT_INTERFACE_APPEARANCE,
    );
    expect(parseInterfaceAppearance("null")).toEqual(
      DEFAULT_INTERFACE_APPEARANCE,
    );
    expect(
      parseInterfaceAppearance('{"mode":"unknown","intensity":900}'),
    ).toEqual({
      ...DEFAULT_INTERFACE_APPEARANCE,
      mode: "full",
      intensity: 100,
    });
    expect(parseInterfaceAppearance('{"mode":"soft","intensity":-4}')).toEqual({
      mode: "soft",
      intensity: 0,
      companionVisible: true,
      fontSize: 115,
    });
    expect(parseInterfaceAppearance('{"mode":"off","intensity":"75"}')).toEqual(
      { mode: "off", intensity: 48, companionVisible: true, fontSize: 115 },
    );
    expect(
      parseInterfaceAppearance('{"companionVisible":"false"}').companionVisible,
    ).toBe(true);
    expect(parseInterfaceAppearance('{"fontSize":500}').fontSize).toBe(125);
    expect(parseInterfaceAppearance('{"fontSize":-10}').fontSize).toBe(85);
    expect(parseInterfaceAppearance('{"fontSize":"120"}').fontSize).toBe(115);
    expect(parseInterfaceAppearance('{"fontSize":100}').fontSize).toBe(100);
  });

  it("applies, saves, restores and resets the interface font size", () => {
    const first = render(
      <>
        <InterfaceAppearanceRoot />
        <InterfaceAppearanceSettings />
      </>,
    );
    expect(
      screen.getByRole("slider", { name: "settings.atelier.fontSize" }),
    ).toHaveValue("115");
    expect(
      document.documentElement.style.getPropertyValue("--interface-font-scale"),
    ).toBe("1.15");
    fireEvent.change(
      screen.getByRole("slider", { name: "settings.atelier.fontSize" }),
      {
        target: { value: "120" },
      },
    );
    expect(
      document.documentElement.style.getPropertyValue("--interface-font-scale"),
    ).toBe("1.2");
    expect(
      JSON.parse(localStorage.getItem(INTERFACE_APPEARANCE_KEY)!).fontSize,
    ).toBe(120);
    first.unmount();
    render(
      <>
        <InterfaceAppearanceRoot />
        <InterfaceAppearanceSettings />
      </>,
    );
    expect(
      screen.getByRole("slider", { name: "settings.atelier.fontSize" }),
    ).toHaveValue("120");
    fireEvent.click(
      screen.getAllByRole("button", { name: "settings.atelier.reset" })[0],
    );
    expect(
      document.documentElement.style.getPropertyValue("--interface-font-scale"),
    ).toBe("1.15");
    expect(
      JSON.parse(localStorage.getItem(INTERFACE_APPEARANCE_KEY)!).fontSize,
    ).toBe(115);
  });

  it("restores the appearance on remount without changing the color-scheme preference", () => {
    localStorage.setItem("cc-switch-theme", "system");
    localStorage.setItem(
      INTERFACE_APPEARANCE_KEY,
      JSON.stringify({ mode: "soft", intensity: 61 }),
    );
    const first = render(<InterfaceAppearanceRoot />);
    expect(document.documentElement).toHaveAttribute("data-decoration", "soft");
    expect(
      document.documentElement.style.getPropertyValue("--atelier-intensity"),
    ).toBe("0.61");
    first.unmount();
    render(<InterfaceAppearanceRoot />);
    expect(document.documentElement).toHaveAttribute("data-decoration", "soft");
    expect(localStorage.getItem("cc-switch-theme")).toBe("system");
  });

  it("applies controls immediately and persists them without a save button", () => {
    render(
      <>
        <InterfaceAppearanceRoot />
        <InterfaceAppearanceSettings />
      </>,
    );
    const slider = screen.getByRole("slider", {
      name: "settings.atelier.intensity",
    });
    fireEvent.change(slider, { target: { value: "73" } });
    expect(
      document.documentElement.style.getPropertyValue("--atelier-intensity"),
    ).toBe("0.73");
    fireEvent.click(
      screen.getByRole("button", { name: "settings.atelier.off" }),
    );
    expect(document.documentElement).toHaveAttribute("data-decoration", "off");
    expect(slider).toBeDisabled();
    expect(JSON.parse(localStorage.getItem(INTERFACE_APPEARANCE_KEY)!)).toEqual(
      { mode: "off", intensity: 73, companionVisible: true, fontSize: 115 },
    );
    fireEvent.click(
      screen.getByRole("button", { name: "settings.atelier.full" }),
    );
    expect(slider).toBeEnabled();
    expect(slider).toHaveValue("73");
  });

  it("updates the current window when another window changes the preference", () => {
    render(<InterfaceAppearanceRoot />);
    act(() => {
      localStorage.setItem(
        INTERFACE_APPEARANCE_KEY,
        JSON.stringify({ mode: "off", intensity: 20 }),
      );
      window.dispatchEvent(
        new StorageEvent("storage", { key: INTERFACE_APPEARANCE_KEY }),
      );
    });
    expect(document.documentElement).toHaveAttribute("data-decoration", "off");
    expect(
      document.documentElement.style.getPropertyValue("--atelier-intensity"),
    ).toBe("0.2");
  });

  it("still applies a choice when local storage cannot be written", () => {
    render(<InterfaceAppearanceRoot />);
    const fail = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new DOMException("full", "QuotaExceededError");
      });
    act(() => saveInterfaceAppearance({ mode: "soft" }));
    expect(document.documentElement).toHaveAttribute("data-decoration", "soft");
    fail.mockRestore();
  });

  it("remembers a hidden companion after remount and can restore it from settings", () => {
    const first = render(<AgentCompanion />);
    expect(screen.getByRole("img")).toHaveAccessibleName(
      "settings.atelier.companionAlt",
    );
    fireEvent.click(
      screen.getByRole("button", { name: "settings.atelier.hideCompanion" }),
    );
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(
      JSON.parse(localStorage.getItem(INTERFACE_APPEARANCE_KEY)!),
    ).toMatchObject({
      companionVisible: false,
    });
    first.unmount();
    render(
      <>
        <AgentCompanion />
        <InterfaceAppearanceSettings />
      </>,
    );
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("switch", { name: "settings.atelier.companion" }),
    );
    expect(screen.getByRole("img")).toBeInTheDocument();
  });

  it("restores the companion from its sidebar control independently of decoration mode", () => {
    saveInterfaceAppearance({ mode: "off", companionVisible: false });
    render(
      <>
        <AgentCompanion />
        <InterfaceAppearanceSettings />
      </>,
    );
    const toggle = screen.getByRole("button", {
      name: "settings.atelier.showCompanion",
    });
    toggle.focus();
    fireEvent.click(toggle);
    expect(screen.getByRole("img")).toBeInTheDocument();
    expect(toggle).toHaveFocus();
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getByRole("switch", { name: "settings.atelier.companion" }),
    ).toBeChecked();
    expect(JSON.parse(localStorage.getItem(INTERFACE_APPEARANCE_KEY)!)).toEqual(
      {
        mode: "off",
        intensity: 48,
        companionVisible: true,
        fontSize: 115,
      },
    );
  });
});
