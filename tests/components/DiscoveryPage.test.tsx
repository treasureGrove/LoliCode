import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DiscoveryPage } from "@/components/discovery/DiscoveryPage";
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
describe("discovery navigation", () => {
  it("shows actual local leaderboard images and enlarges them without opening a website", async () => {
    const user = userEvent.setup();
    mount();
    const images = await screen.findAllByRole("img", {
      name: "discovery.preview.alt Artificial Analysis",
    });
    expect(images[0]).toHaveAttribute(
      "src",
      "data:image/png;base64,c25hcHNob3Q=",
    );
    expect(discoveryApi.preview).toHaveBeenCalledWith("artificial-analysis");
    await user.click(
      screen.getByRole("button", {
        name: "discovery.preview.expand Artificial Analysis",
      }),
    );
    expect(
      screen.getByRole("dialog", { name: "Artificial Analysis" }),
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "discovery.preview.zoomIn" }),
    );
    expect(screen.getByText("125%")).toBeInTheDocument();
    expect(settingsApi.openExternal).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getAllByText("discovery.preview.unavailable")).toHaveLength(
      2,
    );
  });
  it("keeps ranking details and retry available when a snapshot fails", async () => {
    vi.mocked(discoveryApi.preview).mockRejectedValue(new Error("offline"));
    mount();
    await waitFor(() =>
      expect(screen.getAllByText("discovery.preview.unavailable")).toHaveLength(
        5,
      ),
    );
    expect(
      screen.getByRole("heading", { name: "Artificial Analysis" }),
    ).toBeInTheDocument();
    expect(
      screen.getAllByRole("button", { name: "applications.retry" }),
    ).toHaveLength(3);
  });
  it("shows relevant entries, searches both languages and filters categories", async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByRole("heading", { name: "Artificial Analysis" });
    expect(
      screen.queryByRole("heading", { name: "OpenCode Zen" }),
    ).not.toBeInTheDocument();
    await user.type(
      screen.getByRole("textbox", { name: "discovery.search" }),
      "SWE",
    );
    expect(
      screen.getByRole("heading", { name: "SWE-bench" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Arena" }),
    ).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "discovery.clearSearch" }),
    );
    await user.click(
      screen.getByRole("button", { name: /discovery.category.coding/ }),
    );
    expect(
      screen.getByRole("heading", { name: "Aider Leaderboards" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Artificial Analysis" }),
    ).not.toBeInTheDocument();
  });
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
  it("uses a successful updated directory and preserves current content on save failure", async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByRole("heading", { name: "Arena" });
    vi.mocked(discoveryApi.refresh).mockImplementation(async () => {
      store.catalog.entries = store.catalog.entries.filter(
        (x) => x.id !== "arena",
      );
      store.source = "cache";
      store.catalog.revision++;
      return structuredClone(store);
    });
    await user.click(screen.getByRole("button", { name: "discovery.refresh" }));
    await screen.findByText("discovery.refreshed");
    expect(
      screen.queryByRole("heading", { name: "Arena" }),
    ).not.toBeInTheDocument();
    vi.mocked(discoveryApi.favorite).mockRejectedValueOnce(
      new Error("disk full"),
    );
    await user.click(
      screen.getByRole("button", { name: "discovery.favorite LiveBench" }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "discovery.favorite LiveBench" }),
      ).toBeEnabled(),
    );
    expect(
      screen.getByRole("heading", { name: "LiveBench" }),
    ).toBeInTheDocument();
  });
});
