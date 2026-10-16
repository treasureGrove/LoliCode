import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import companion from "@/assets/atelier/companion.png";
import { SidebarProfileMenu } from "@/components/shell/SidebarProfileMenu";

const locale = vi.hoisted(() => ({ language: "zh" }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    i18n: { language: locale.language },
    t: (key: string, options?: { defaultValue?: string }) =>
      options?.defaultValue || key,
  }),
}));

beforeEach(() => {
  locale.language = "zh";
});

describe("sidebar profile menu", () => {
  it("uses the local companion as its trigger without opening an account flow", async () => {
    const onOpenSettings = vi.fn();
    const onOpenUpdates = vi.fn();
    const { rerender } = render(
      <SidebarProfileMenu
        selected
        onOpenSettings={onOpenSettings}
        onOpenUpdates={onOpenUpdates}
      />,
    );
    const trigger = screen.getByRole("button", { name: "头像与设置" });
    expect(trigger).toHaveAttribute("data-selected", "true");
    expect(trigger.querySelector("img")).toHaveAttribute("src", companion);
    expect(trigger).not.toHaveAttribute("aria-describedby");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    await userEvent.setup().click(trigger);
    expect(screen.getByRole("menu")).toHaveTextContent("LoliCode");
    expect(onOpenSettings).not.toHaveBeenCalled();
    expect(onOpenUpdates).not.toHaveBeenCalled();
    rerender(
      <SidebarProfileMenu
        onOpenSettings={onOpenSettings}
        onOpenUpdates={onOpenUpdates}
      />,
    );
    expect(trigger).toHaveAttribute("data-selected", "false");
  });

  it("opens settings only after the settings menu item is selected", async () => {
    const user = userEvent.setup();
    const onOpenSettings = vi.fn();
    const onOpenUpdates = vi.fn();
    render(
      <SidebarProfileMenu
        onOpenSettings={onOpenSettings}
        onOpenUpdates={onOpenUpdates}
      />,
    );
    const trigger = screen.getByRole("button", { name: "头像与设置" });
    await user.click(trigger);
    await user.click(screen.getByRole("menuitem", { name: "设置" }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    expect(onOpenUpdates).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.queryByRole("menu")).not.toBeInTheDocument(),
    );
    expect(trigger).toHaveFocus();
  });

  it("preserves the new-version notice and routes software updates separately", async () => {
    const user = userEvent.setup();
    const onOpenSettings = vi.fn();
    const onOpenUpdates = vi.fn();
    render(
      <SidebarProfileMenu
        hasUpdate
        onOpenSettings={onOpenSettings}
        onOpenUpdates={onOpenUpdates}
      />,
    );
    const trigger = screen.getByRole("button", { name: "头像与设置" });
    expect(trigger).toHaveAccessibleDescription("发现 LoliCode 新版本");
    await user.click(trigger);
    const updates = screen.getByRole("menuitem", { name: /^软件更新/ });
    expect(updates).toHaveAccessibleName("软件更新 · 发现 LoliCode 新版本");
    await user.click(updates);
    expect(onOpenUpdates).toHaveBeenCalledTimes(1);
    expect(onOpenSettings).not.toHaveBeenCalled();
  });

  it("supports keyboard selection and Escape with focus returning to the avatar", async () => {
    const user = userEvent.setup();
    const onOpenSettings = vi.fn();
    const onOpenUpdates = vi.fn();
    render(
      <SidebarProfileMenu
        onOpenSettings={onOpenSettings}
        onOpenUpdates={onOpenUpdates}
      />,
    );
    const trigger = screen.getByRole("button", { name: "头像与设置" });
    trigger.focus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "设置" })).toHaveFocus();
    await user.keyboard("{ArrowDown}{Enter}");
    expect(onOpenUpdates).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(screen.queryByRole("menu")).not.toBeInTheDocument(),
    );
    expect(trigger).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("menu")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("menu")).not.toBeInTheDocument(),
    );
    expect(trigger).toHaveFocus();
    expect(onOpenSettings).not.toHaveBeenCalled();
    expect(document.body.style.pointerEvents).not.toBe("none");
  });

  it("uses the editor language for the profile label and actions", async () => {
    locale.language = "en";
    render(
      <SidebarProfileMenu onOpenSettings={vi.fn()} onOpenUpdates={vi.fn()} />,
    );
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Profile and settings" }));
    expect(
      screen.getByRole("menuitem", { name: "Settings" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: "Software updates" }),
    ).toBeInTheDocument();
  });
});
