import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "i18next";
import { DiscoveryPage } from "@/features/discovery/DiscoveryPage";
import {
  rankedModels,
  rankingSnapshot,
  type RankedModel,
} from "@/lib/ai-rankings";
import { settingsApi } from "@/lib/api/settings";
import { toast } from "@/lib/toast";
import zh from "@/i18n/locales/rankings/zh.json";
import { RANKINGS_CACHE_KEY } from "@/lib/query/aiRankings";

vi.mock("@/lib/api/settings", () => ({
  settingsApi: { openExternal: vi.fn() },
}));
vi.mock("@/lib/toast", () => ({ toast: { error: vi.fn() } }));

beforeEach(async () => {
  vi.clearAllMocks();
  localStorage.removeItem(RANKINGS_CACHE_KEY);
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
  i18n.addResourceBundle("zh", "rankings", zh, true, true);
  await i18n.changeLanguage("zh");
  vi.mocked(settingsApi.openExternal).mockResolvedValue();
});

afterEach(() => vi.unstubAllGlobals());

function text(key: keyof typeof zh, options: Record<string, unknown> = {}) {
  return i18n.t(key, { ns: "rankings", ...options });
}

function barName(model: RankedModel) {
  return text("barLabel", {
    name: model.name,
    rank: model.rank,
    score: model.composite.toFixed(2),
    coverage: model.coverage,
    totalSources: rankingSnapshot.sources.length,
  });
}

function chartBars() {
  return within(
    screen.getByRole("group", { name: zh.chartTitle }),
  ).getAllByRole("button", { name: /，综合分 / });
}

describe("single composite AI ranking chart", () => {
  it("renders one researched chart with the leading 12 models and no old table", async () => {
    render(<DiscoveryPage kind="rankings" />);
    expect(screen.getAllByRole("group", { name: zh.chartTitle })).toHaveLength(
      1,
    );
    expect(chartBars()).toHaveLength(12);
    expect(
      screen.getByRole("button", { name: barName(rankedModels[0]) }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(`检索快照 · ${rankingSnapshot.retrievedAt}`),
    ).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.queryByText("discovery.refresh")).not.toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId("rankings-feed-status")).toHaveTextContent(
        zh.refreshFailed,
      ),
    );
  });

  it("shows every model on request, including zero scores, and can return to the top 12", async () => {
    const user = userEvent.setup();
    render(<DiscoveryPage kind="rankings" />);
    await user.click(
      screen.getByRole("button", {
        name: text("showAllModels", { count: rankedModels.length }),
      }),
    );
    expect(chartBars()).toHaveLength(rankedModels.length);
    const zeroScore = rankedModels.find((model) => model.composite === 0)!;
    expect(
      screen.getByRole("button", { name: barName(zeroScore) }),
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: text("topModels", { count: 12 }) }),
    );
    expect(chartBars()).toHaveLength(12);
  });

  it("uses the server snapshot in the chart, source links and evidence dates", async () => {
    const user = userEvent.setup();
    const next = structuredClone(rankingSnapshot) as any;
    next.models[0].name = "Daily verified model";
    next.sources[0].name = "Artificial Analysis daily";
    next.sources[0].updatedAt = "2026-10-27";
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify(next), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    render(<DiscoveryPage kind="rankings" />);
    const bar = await screen.findByRole("button", {
      name: /Daily verified model，/,
    });
    expect(screen.getByTestId("rankings-feed-status")).toHaveTextContent(
      zh.feedSource.online,
    );
    expect(
      screen.getByRole("button", {
        name: "Artificial Analysis daily",
      }),
    ).toBeInTheDocument();
    await user.click(bar);
    const dialog = screen.getByRole("dialog", { name: "Daily verified model" });
    expect(
      within(dialog).getByText("数据版本 · 2026-10-27"),
    ).toBeInTheDocument();
  });

  it("labels partial source coverage when the daily snapshot has no Arena results", async () => {
    const next = structuredClone(rankingSnapshot) as any;
    next.models = next.models.filter(
      (model: any) =>
        model.measurements["artificial-analysis"] &&
        model.measurements.livebench,
    );
    for (const model of next.models) model.measurements.arena = null;
    next.sources[2].updatedAt = null;
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify(next), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    render(<DiscoveryPage kind="rankings" />);
    expect(
      await screen.findByText(
        text("sourceAvailability", { available: 2, total: 3 }),
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("2/3", { selector: "strong" })).toBeInTheDocument();
    expect(screen.getByTestId("rankings-feed-status")).toHaveTextContent(
      zh.feedSource.online,
    );
  });

  it("searches model names case-insensitively and preserves their published rank and score", async () => {
    const user = userEvent.setup();
    render(<DiscoveryPage kind="rankings" />);
    const model = rankedModels.find((entry) => entry.id === "gpt-6.1-sol")!;
    await user.type(
      screen.getByRole("textbox", { name: zh.search }),
      `  ${model.name.toUpperCase()}  `,
    );
    expect(chartBars()).toHaveLength(1);
    expect(
      screen.getByRole("button", { name: barName(model) }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: zh.clearSearch }));
    expect(chartBars()).toHaveLength(12);
  });

  it("combines provider and license filters and recovers from empty results", async () => {
    const user = userEvent.setup();
    render(<DiscoveryPage kind="rankings" />);
    await user.selectOptions(
      screen.getByRole("combobox", { name: zh.provider }),
      "OpenAI",
    );
    await user.click(screen.getByRole("button", { name: zh.openWeights }));
    expect(screen.getByText(zh.noResults)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: zh.resetFilters }));
    expect(screen.queryByText(zh.noResults)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: zh.openWeights }));
    const openModels = rankedModels.filter((model) => model.openWeights);
    expect(chartBars()).toHaveLength(Math.min(12, openModels.length));
    expect(
      screen.queryByRole("button", {
        name: barName(
          rankedModels.find((model) => model.id === "gpt-6.1-sol")!,
        ),
      }),
    ).not.toBeInTheDocument();
  });

  it("shows a compact score preview on hover and keyboard focus", async () => {
    const user = userEvent.setup();
    render(<DiscoveryPage kind="rankings" />);
    const model = rankedModels[0];
    const bar = screen.getByRole("button", { name: barName(model) });
    await user.hover(bar);
    const tooltip = await screen.findByRole("tooltip");
    expect(within(tooltip).getByText(model.name)).toBeInTheDocument();
    expect(
      within(tooltip).getByText(
        model.measurements["artificial-analysis"]!.score.toFixed(2),
      ),
    ).toBeInTheDocument();
    expect(within(tooltip).getByText(zh.hoverHint)).toBeInTheDocument();
    expect(settingsApi.openExternal).not.toHaveBeenCalled();
    await user.unhover(bar);
    act(() => bar.focus());
    expect(await screen.findByRole("tooltip")).toBeInTheDocument();
    expect(bar).toHaveFocus();
  });

  it("keeps one preview mounted while crossing the gaps between bars", async () => {
    const user = userEvent.setup();
    render(<DiscoveryPage kind="rankings" />);
    const first = screen.getByRole("button", {
      name: barName(rankedModels[0]),
    });
    const second = screen.getByRole("button", {
      name: barName(rankedModels[2]),
    });
    await user.hover(first);
    const preview = await screen.findByRole("tooltip");
    await user.unhover(first);
    expect(screen.getByRole("tooltip")).toBe(preview);
    await user.hover(second);
    expect(screen.getAllByRole("tooltip")).toHaveLength(1);
    expect(screen.getByRole("tooltip")).toBe(preview);
    expect(within(preview).getByText(rankedModels[2].name)).toBeInTheDocument();
    expect(second).toHaveAttribute("aria-describedby", preview.id);
    expect(first).not.toHaveAttribute("aria-describedby");
    await user.unhover(second);
    await waitFor(() =>
      expect(screen.queryByRole("tooltip")).not.toBeInTheDocument(),
    );
  });

  it("dismisses stale previews on Escape, scrolling, resize and filtering", async () => {
    const user = userEvent.setup();
    render(<DiscoveryPage kind="rankings" />);
    const bar = screen.getByRole("button", { name: barName(rankedModels[0]) });
    act(() => bar.focus());
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    await user.hover(bar);
    await screen.findByRole("tooltip");
    fireEvent.scroll(window);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    await user.unhover(bar);
    await user.hover(bar);
    await screen.findByRole("tooltip");
    fireEvent.resize(window);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    await user.unhover(bar);
    await user.hover(bar);
    await screen.findByRole("tooltip");
    await user.type(screen.getByRole("textbox", { name: zh.search }), "Gemini");
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("does not open hover previews for touch pointers", async () => {
    render(<DiscoveryPage kind="rankings" />);
    const bar = screen.getByRole("button", { name: barName(rankedModels[0]) });
    const touch = new MouseEvent("pointerover", { bubbles: true });
    Object.defineProperty(touch, "pointerType", { value: "touch" });
    fireEvent(bar, touch);
    const touchDown = new MouseEvent("pointerdown", { bubbles: true });
    Object.defineProperty(touchDown, "pointerType", { value: "touch" });
    fireEvent(bar, touchDown);
    act(() => bar.focus());
    expect(bar).toHaveFocus();
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId("rankings-feed-status")).toHaveTextContent(
        zh.refreshFailed,
      ),
    );
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("retains the preview and chart when focus events repeat without new data", async () => {
    const user = userEvent.setup();
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify(rankingSnapshot), { status: 200 }),
    );
    render(<DiscoveryPage kind="rankings" />);
    await waitFor(() =>
      expect(screen.getByTestId("rankings-feed-status")).toHaveTextContent(
        zh.feedSource.online,
      ),
    );
    const bar = screen.getByRole("button", { name: barName(rankedModels[0]) });
    await user.hover(bar);
    const preview = await screen.findByRole("tooltip");
    act(() => {
      for (let index = 0; index < 10; index++)
        window.dispatchEvent(new Event("focus"));
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("tooltip")).toBe(preview);
    expect(screen.getByRole("button", { name: barName(rankedModels[0]) })).toBe(
      bar,
    );
    expect(screen.getByTestId("rankings-feed-status")).toHaveTextContent(
      zh.feedSource.online,
    );
  });

  it("opens full source evidence on click and restores focus when closed", async () => {
    const user = userEvent.setup();
    render(<DiscoveryPage kind="rankings" />);
    const model = rankedModels.find((entry) => entry.id === "claude-opus-5.5")!;
    const bar = screen.getByRole("button", { name: barName(model) });
    await user.click(bar);
    const dialog = screen.getByRole("dialog", { name: model.name });
    expect(
      within(dialog).getByText(
        model.measurements["artificial-analysis"]!.configuration,
      ),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText("数据版本 · 2026-10-25"),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText("数据版本 · 2026-10-22"),
    ).toBeInTheDocument();
    expect(within(dialog).getByText(zh.unpublishedDate)).toBeInTheDocument();
    await user.click(
      within(dialog).getByRole("button", {
        name: `${zh.readSource} Artificial Analysis ${model.name}`,
      }),
    );
    expect(settingsApi.openExternal).toHaveBeenCalledWith(
      model.measurements["artificial-analysis"]!.url,
    );
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(bar).toHaveFocus();
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("explains the index and handles failed source links without losing the chart", async () => {
    const user = userEvent.setup();
    render(<DiscoveryPage kind="rankings" />);
    const methodButton = screen.getAllByRole("button", { name: zh.method })[0];
    await user.click(methodButton);
    const dialog = screen.getByRole("dialog", { name: zh.methodologyTitle });
    expect(within(dialog).getByText(zh.methodologySteps)).toBeInTheDocument();
    expect(
      within(dialog).getByText(
        text("methodologyDates", { date: rankingSnapshot.retrievedAt }),
      ),
    ).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(methodButton).toHaveFocus();
    vi.mocked(settingsApi.openExternal).mockRejectedValueOnce(
      new Error("unavailable"),
    );
    await user.click(
      screen.getAllByRole("button", { name: "Artificial Analysis" })[0],
    );
    expect(toast.error).toHaveBeenCalledWith(zh.openFailed);
    expect(
      screen.getByRole("group", { name: zh.chartTitle }),
    ).toBeInTheDocument();
  });
});
