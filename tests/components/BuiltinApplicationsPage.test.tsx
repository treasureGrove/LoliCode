import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { BuiltinApplicationsPage } from "@/features/apps/BuiltinApplicationsPage";
import { builtinAppsKey } from "@/lib/api/builtin-apps";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/app/shell/AppPageHeader", () => ({
  AppPageHeader: ({ title }: { title: string }) => <h1>{title}</h1>,
}));
vi.mock("@/lib/toast", () => ({ toast: { error: vi.fn() } }));

const stored = { tavern: false, unreal: false };
beforeEach(() => {
  stored.tavern = false;
  stored.unreal = false;
  vi.mocked(invoke)
    .mockReset()
    .mockImplementation(async (command, args) => {
      if (command === "list_builtin_apps")
        return Object.entries(stored).map(([id, enabled]) => ({ id, enabled }));
      if (command === "set_builtin_app_enabled") {
        const { app, enabled } = args as {
          app: keyof typeof stored;
          enabled: boolean;
        };
        stored[app] = enabled;
        return undefined;
      }
      throw new Error("Unexpected command");
    });
});
function mount(onOpen = vi.fn()) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return {
    client,
    onOpen,
    ...render(
      <QueryClientProvider client={client}>
        <BuiltinApplicationsPage onOpen={onOpen} />
      </QueryClientProvider>,
    ),
  };
}

describe("built-in application lifecycle", () => {
  it("adds before opening, removes without deleting domain data and reloads persisted state", async () => {
    const user = userEvent.setup();
    const first = mount();
    await waitFor(() =>
      expect(
        screen.getAllByRole("button", { name: /applications.add/ })[0],
      ).toBeEnabled(),
    );
    expect(
      screen.queryByRole("button", { name: "applications.open" }),
    ).not.toBeInTheDocument();
    await user.click(
      screen.getAllByRole("button", { name: /applications.add/ })[0],
    );
    await user.click(
      await screen.findByRole("button", { name: "applications.open" }),
    );
    expect(first.onOpen).toHaveBeenCalledWith("tavern");
    first.unmount();
    mount();
    await user.click(
      await screen.findByRole("button", { name: "applications.remove" }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "applications.open" }),
      ).not.toBeInTheDocument(),
    );
    expect(invoke).toHaveBeenCalledWith("set_builtin_app_enabled", {
      app: "tavern",
      enabled: false,
    });
    expect(
      vi
        .mocked(invoke)
        .mock.calls.every(([command]) =>
          ["list_builtin_apps", "set_builtin_app_enabled"].includes(command),
        ),
    ).toBe(true);
  });

  it("keeps an app available when persistence fails", async () => {
    stored.tavern = true;
    const user = userEvent.setup();
    const { client } = mount();
    await screen.findByRole("button", { name: "applications.open" });
    vi.mocked(invoke).mockRejectedValueOnce(new Error("disk unavailable"));
    await user.click(
      screen.getByRole("button", { name: "applications.remove" }),
    );
    expect(
      await screen.findByRole("button", { name: "applications.open" }),
    ).toBeInTheDocument();
    expect(client.getQueryData(builtinAppsKey)).toEqual([
      { id: "tavern", enabled: true },
      { id: "unreal", enabled: false },
    ]);
  });
});
