import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentCompanion } from "@/features/agent/AgentCompanion";

const appearance = vi.hoisted(() => ({
  companionVisible: false,
  setAppearance: vi.fn(),
}));
vi.mock("@/hooks/useInterfaceAppearance", () => ({
  useInterfaceAppearance: () => ({
    appearance,
    setAppearance: appearance.setAppearance,
  }),
}));
vi.mock("@/app/shell/ResourcePackProvider", () => ({
  useResourceImage: (_key: string, fallback: string) => fallback,
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe("optional companion visibility", () => {
  beforeEach(() => {
    appearance.companionVisible = false;
    appearance.setAppearance.mockReset();
  });

  it("leaves no restore control while hidden and responds to appearance settings", () => {
    const view = render(<AgentCompanion />);
    expect(view.container).toBeEmptyDOMElement();
    appearance.companionVisible = true;
    view.rerender(<AgentCompanion />);
    expect(screen.getByRole("img")).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: "settings.atelier.hideCompanion" }),
    );
    expect(appearance.setAppearance).toHaveBeenCalledWith({
      companionVisible: false,
    });
  });
});
