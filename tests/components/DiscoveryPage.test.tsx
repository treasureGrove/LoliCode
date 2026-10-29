import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DiscoveryPage } from "@/features/discovery/DiscoveryPage";
import { discoveryApi, type DiscoverySnapshot } from "@/lib/api/discovery";
import { settingsApi } from "@/lib/api/settings";
import bundled from "@/public/discovery-v1.json";

vi.mock("@/lib/api/discovery", async (original) => ({
  ...(await original<typeof import("@/lib/api/discovery")>()),
  discoveryApi: {
    get: vi.fn(),
    refresh: vi.fn(),
    favorite: vi.fn(),
    preview: vi.fn(),
  },
}));
vi.mock("@/lib/api/settings", () => ({
  settingsApi: { openExternal: vi.fn() },
}));
vi.mock("@/lib/toast", () => ({ toast: { error: vi.fn() } }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    i18n: { language: "zh" },
    t: (key: string, options?: { name?: string }) =>
      `${key}${options?.name ? ` ${options.name}` : ""}`,
  }),
}));
let store: DiscoverySnapshot;
beforeEach(() => {
  vi.clearAllMocks();
  store = {
    catalog: structuredClone(bundled) as DiscoverySnapshot["catalog"],
    source: "builtin",
    favorites: [],
  };
  vi.mocked(discoveryApi.preview).mockResolvedValue({
    dataUrl: "data:image/png;base64,c25hcHNob3Q=",
    capturedAt: "2026-10-19",
    stale: false,
  });
  vi.mocked(discoveryApi.get).mockImplementation(async () =>
    structuredClone(store),
  );
  vi.mocked(discoveryApi.favorite).mockImplementation(
    async (_app, id, saved) => {
      store.favorites = store.favorites.filter((x) => x !== id);
      if (saved) store.favorites.push(id);
      return structuredClone(store);
    },
  );
  vi.mocked(discoveryApi.refresh).mockRejectedValue(new Error("offline"));
  vi.mocked(settingsApi.openExternal).mockResolvedValue();
});
function mount(kind: "rankings" | "free-ai" = "rankings") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <DiscoveryPage kind={kind} />
    </QueryClientProvider>,
  );
}
describe("free AI discovery navigation", () => {
  it("persists favorites across reopening and retains them after a failed refresh", async () => {
    const user = userEvent.setup();
    const first = mount("free-ai");
    await screen.findByRole("heading", { name: "OpenCode Zen" });
    await user.click(
      screen.getByRole("button", { name: "discovery.favorite OpenCode Zen" }),
    );
    await screen.findByRole("button", {
      name: "discovery.unfavorite OpenCode Zen",
    });
    first.unmount();
    mount("free-ai");
    await screen.findByRole("button", {
      name: "discovery.unfavorite OpenCode Zen",
    });
    await user.click(
      screen.getByRole("button", { name: "discovery.favorites" }),
    );
    expect(
      screen.queryByRole("heading", { name: "OpenRouter Free" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "discovery.refresh" }));
    await screen.findByText("discovery.refreshUnavailable");
    expect(
      screen.getByRole("heading", { name: "OpenCode Zen" }),
    ).toBeInTheDocument();
  });
  it("opens the selected official website without invoking a model", async () => {
    const user = userEvent.setup();
    mount("free-ai");
    await screen.findByRole("heading", { name: "OpenCode Zen" });
    await user.type(
      screen.getByRole("textbox", { name: "discovery.search" }),
      "OpenCode",
    );
    await user.click(screen.getByRole("button", { name: "discovery.visit" }));
    await waitFor(() =>
      expect(settingsApi.openExternal).toHaveBeenCalledWith(
        "https://opencode.ai/zen",
      ),
    );
    expect(
      screen.getByText("discovery.offer.limited-free"),
    ).toBeInTheDocument();
  });
});
