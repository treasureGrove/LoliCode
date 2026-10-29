import { act, render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ProviderCardActions } from "@/features/providers/ProviderCardActions";
import type { CardPresentation } from "@/features/providers/presentation";

async function openMenu(presentation: CardPresentation) {
  const user = userEvent.setup();
  render(
    <ProviderCardActions
      providerName="Kimi"
      presentation={presentation}
      onEdit={vi.fn()}
      onDelete={vi.fn()}
      onDuplicate={vi.fn()}
    />,
  );
  await user.click(
    screen.getByRole("button", { name: "providerCard.action.more" }),
  );
  return { user, menu: await screen.findByRole("menu") };
}

describe("ProviderCardActions — mode items in the more menu", () => {
  it("waits for a real provider action and rejects duplicate clicks", async () => {
    const user = userEvent.setup();
    let resolve!: () => void;
    const onClick = vi.fn(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    );
    render(
      <ProviderCardActions
        providerName="Kimi"
        presentation={{
          chips: [],
          buttons: [{ key: "switch", label: "Use Kimi", onClick }],
        }}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    const button = screen.getByRole("button", { name: "Use Kimi" });

    await user.click(button);
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    await user.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);

    await act(async () => resolve());
    await waitFor(() => expect(button).toBeEnabled());
    expect(button).not.toHaveAttribute("aria-busy");
  });

  it("leaves a failed provider action available for retry", async () => {
    const user = userEvent.setup();
    const onClick = vi
      .fn()
      .mockRejectedValue(new Error("Connection unavailable"));
    render(
      <ProviderCardActions
        providerName="Kimi"
        presentation={{
          chips: [],
          buttons: [{ key: "switch", label: "Use Kimi", onClick }],
        }}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    const button = screen.getByRole("button", { name: "Use Kimi" });
    await user.click(button);
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it("lists them first", async () => {
    const onSelect = vi.fn();
    const { user, menu } = await openMenu({
      buttons: [],
      chips: [],
      menuItems: [
        {
          key: "setDefault",
          label: "providerCard.action.setDefault",
          onSelect,
        },
      ],
    });

    const items = within(menu).getAllByRole("menuitem");
    expect(items[0]).toHaveTextContent("providerCard.action.setDefault");
    expect(items[1]).toHaveTextContent("provider.duplicate");

    await user.click(items[0]);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("keeps a disabled one listed with its reason", async () => {
    const onSelect = vi.fn();
    const { user, menu } = await openMenu({
      buttons: [],
      chips: [],
      menuItems: [
        {
          key: "setDefault",
          label: "providerCard.action.setDefault",
          disabledReason: "providerCard.reason.defaultWhileRouting",
          onSelect,
        },
      ],
    });

    const item = within(menu).getAllByRole("menuitem")[0];
    expect(item).toHaveAttribute("aria-disabled", "true");
    expect(item).toHaveTextContent("providerCard.reason.defaultWhileRouting");
    await user.click(item);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("shows only the usual items when the mode has none", async () => {
    const { menu } = await openMenu({ buttons: [], chips: [] });

    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual(["provider.duplicate", "common.delete"]);
  });
});
