import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { BuiltinApplicationsPage } from "@/features/apps/BuiltinApplicationsPage";
import {
  BUILTIN_APP_IDS,
  builtinAppsKey,
  type BuiltinAppId,
} from "@/lib/api/builtin-apps";
import { toast } from "@/lib/toast";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/app/shell/AppPageHeader", () => ({
  AppPageHeader: ({ title }: { title: string }) => <h1>{title}</h1>,
}));
vi.mock("@/lib/toast", () => ({ toast: { error: vi.fn() } }));

const stored: Record<BuiltinAppId, boolean> = {
  tavern: false,
  unreal: false,
  rankings: false,
  "free-ai": false,
};
beforeEach(() => {
  for (const id of BUILTIN_APP_IDS) stored[id] = false;
  vi.mocked(toast.error).mockClear();
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
  it("enables and opens in one action, then disables without deleting domain data", async () => {
    const user = userEvent.setup();
    const first = mount();
    await waitFor(() =>
      expect(
        screen.getAllByRole("button", {
          name: "applications.enableAndOpen",
        })[0],
      ).toBeEnabled(),
    );
    expect(
      screen.queryByRole("button", { name: "applications.open" }),
    ).not.toBeInTheDocument();
    await user.click(
      screen.getAllByRole("button", { name: "applications.enableAndOpen" })[0],
    );
    await waitFor(() => expect(first.onOpen).toHaveBeenCalledWith("tavern"));
    expect(first.onOpen).toHaveBeenCalledOnce();
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
      { id: "rankings", enabled: false },
      { id: "free-ai", enabled: false },
    ]);
  });

  it.each(BUILTIN_APP_IDS)(
    "opens %s only after its enabled state is visible to the application route guard",
    async (id) => {
      const user = userEvent.setup();
      const onOpen = vi.fn((openedId: BuiltinAppId) => {
        expect(openedId).toBe(id);
        expect(view.client.getQueryData(builtinAppsKey)).toEqual(
          expect.arrayContaining([{ id, enabled: true }]),
        );
      });
      const view = mount(onOpen);
      const card = screen.getByRole("article", {
        name: `applications.${id}.title`,
      });
      const enable = within(card).getByRole("button", {
        name: "applications.enableAndOpen",
      });
      await waitFor(() => expect(enable).toBeEnabled());
      await user.click(enable);
      await waitFor(() => expect(onOpen).toHaveBeenCalledOnce());
      expect(invoke).toHaveBeenCalledWith("set_builtin_app_enabled", {
        app: id,
        enabled: true,
      });
    },
  );

  it("keeps a disabled application closed if enabling cannot be saved", async () => {
    const user = userEvent.setup();
    const view = mount();
    const enable = within(
      screen.getByRole("article", { name: "applications.unreal.title" }),
    ).getByRole("button", { name: "applications.enableAndOpen" });
    await waitFor(() => expect(enable).toBeEnabled());
    vi.mocked(invoke).mockRejectedValueOnce(new Error("disk unavailable"));
    await user.click(enable);
    await waitFor(() => expect(toast.error).toHaveBeenCalledOnce());
    expect(view.onOpen).not.toHaveBeenCalled();
    expect(view.client.getQueryData(builtinAppsKey)).toEqual(
      expect.arrayContaining([{ id: "unreal", enabled: false }]),
    );
    expect(enable).toBeEnabled();
  });

  it("waits for persistence before opening and prevents another action during the change", async () => {
    stored.tavern = true;
    const view = mount();
    const enable = within(
      screen.getByRole("article", { name: "applications.rankings.title" }),
    ).getByRole("button", { name: "applications.enableAndOpen" });
    await waitFor(() => expect(enable).toBeEnabled());
    let finish!: (value: undefined) => void;
    vi.mocked(invoke).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    fireEvent.click(enable);
    expect(view.onOpen).not.toHaveBeenCalled();
    expect(enable).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "applications.open" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "applications.remove" }),
    ).toBeDisabled();
    fireEvent.click(enable);
    expect(
      vi
        .mocked(invoke)
        .mock.calls.filter(
          ([command]) => command === "set_builtin_app_enabled",
        ),
    ).toHaveLength(1);
    stored.rankings = true;
    finish(undefined);
    await waitFor(() => expect(view.onOpen).toHaveBeenCalledWith("rankings"));
  });

  it("keeps actions unavailable when loading fails and lets the user retry", async () => {
    const user = userEvent.setup();
    vi.mocked(invoke).mockRejectedValueOnce(new Error("read failed"));
    mount();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "applications.loadFailed",
    );
    for (const button of screen.getAllByRole("button", {
      name: "applications.enableAndOpen",
    })) {
      expect(button).toBeDisabled();
    }
    await user.click(
      screen.getByRole("button", { name: "applications.retry" }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("alert")).not.toBeInTheDocument(),
    );
    for (const button of screen.getAllByRole("button", {
      name: "applications.enableAndOpen",
    })) {
      expect(button).toBeEnabled();
    }
  });
});
