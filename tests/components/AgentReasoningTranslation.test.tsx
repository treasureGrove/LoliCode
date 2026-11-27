import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ViewActivityContext } from "@/components/ViewActivityContext";
import { AgentReasoningPart } from "@/features/agent/AgentParts";
import {
  AgentReasoningSessionCache,
  type AgentReasoningSessionTranslations,
} from "@/features/agent/AgentReasoningTranslation";

const requests = vi.hoisted(() => ({
  translateReasoning: vi.fn(),
  cancelReasoningTranslation: vi.fn(),
}));

vi.mock("@/lib/api/agent", async (load) => {
  const api = await load<typeof import("@/lib/api/agent")>();
  return { ...api, agentApi: { ...api.agentApi, ...requests } };
});

const preference = "lolicode:agent:reasoningTranslation";
const targetPreference = "lolicode:agent:reasoningTranslationTarget";
const source = "Check the example locally before editing it.";
const summary = () => screen.getByText("思考过程");

function part(text = source, streaming = false) {
  return (
    <AgentReasoningPart
      part={{ text }}
      projectPath="/project"
      streaming={streaming}
    />
  );
}

beforeEach(() => {
  localStorage.removeItem(preference);
  localStorage.removeItem(targetPreference);
  requests.translateReasoning.mockReset();
  requests.cancelReasoningTranslation.mockReset().mockResolvedValue(undefined);
});

describe("Agent reasoning translation", () => {
  it("opts in before sending, translates only the expanded block, and keeps the original available", async () => {
    const user = userEvent.setup();
    const translated =
      "先检查示例。 ![远程图片](https://example.com/track.png)";
    requests.translateReasoning.mockResolvedValue(translated);
    render(part());
    expect(requests.translateReasoning).not.toHaveBeenCalled();

    await user.click(summary());
    expect(screen.getByText(source)).toBeVisible();
    const consent = screen.getByRole("button", { name: "开启自动翻译" });
    expect(consent).toHaveAccessibleDescription(/Microsoft Bing/);
    expect(requests.translateReasoning).not.toHaveBeenCalled();

    await user.click(consent);
    expect(await screen.findByText(translated)).toBeVisible();
    expect(requests.translateReasoning).toHaveBeenCalledTimes(1);
    expect(requests.translateReasoning).toHaveBeenCalledWith(
      source,
      "zh-CN",
      expect.any(String),
      "bing",
    );
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "显示原文" }));
    expect(screen.getByText(source)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "显示译文" }));
    expect(screen.getByText(translated)).toBeVisible();
    await user.click(summary());
    await user.click(summary());
    expect(await screen.findByText(translated)).toBeVisible();
    expect(requests.translateReasoning).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "关闭自动翻译" }));
    expect(screen.getByText(source)).toBeVisible();
  });

  it("preserves the original on failure and retries only on request", async () => {
    const user = userEvent.setup();
    localStorage.setItem(preference, "true");
    requests.translateReasoning
      .mockRejectedValueOnce(new Error("unavailable"))
      .mockResolvedValueOnce("翻译成功");
    render(part());
    await user.click(summary());
    expect(await screen.findByText("翻译失败，已显示原文")).toBeVisible();
    expect(screen.getByText(source)).toBeVisible();
    expect(requests.translateReasoning).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "重试翻译" }));
    expect(await screen.findByText("翻译成功")).toBeVisible();
    expect(requests.translateReasoning).toHaveBeenCalledTimes(2);
  });

  it("shares one pending translation until the last open disclosure closes", async () => {
    const user = userEvent.setup();
    localStorage.setItem(preference, "true");
    let resolveTranslation!: (value: string) => void;
    requests.translateReasoning.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolveTranslation = resolve;
        }),
    );
    render(
      <AgentReasoningSessionCache.Provider value={new Map()}>
        {part()}
        {part()}
      </AgentReasoningSessionCache.Provider>,
    );
    const [first, second] = screen.getAllByText("思考过程");
    await user.click(first);
    await user.click(second);
    await waitFor(() =>
      expect(screen.getAllByText("正在翻译…")).toHaveLength(2),
    );
    expect(requests.translateReasoning).toHaveBeenCalledTimes(1);

    await user.click(first);
    await waitFor(() =>
      expect(screen.getAllByText("正在翻译…")).toHaveLength(1),
    );
    expect(requests.cancelReasoningTranslation).not.toHaveBeenCalled();
    await act(async () => resolveTranslation("共享译文"));
    expect(await screen.findByText("共享译文")).toBeVisible();

    await user.click(first);
    await waitFor(() =>
      expect(screen.getAllByText("共享译文")).toHaveLength(2),
    );
    expect(requests.translateReasoning).toHaveBeenCalledTimes(1);
  });

  it("cancels a shared request once and ignores its result after reopening", async () => {
    const user = userEvent.setup();
    localStorage.setItem(preference, "true");
    let resolveCancelled!: (value: string) => void;
    let resolveNew!: (value: string) => void;
    requests.translateReasoning
      .mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            resolveCancelled = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            resolveNew = resolve;
          }),
      );
    render(
      <AgentReasoningSessionCache.Provider value={new Map()}>
        {part()}
        {part()}
      </AgentReasoningSessionCache.Provider>,
    );
    const [first, second] = screen.getAllByText("思考过程");
    await user.click(first);
    await user.click(second);
    await waitFor(() =>
      expect(screen.getAllByText("正在翻译…")).toHaveLength(2),
    );
    expect(requests.translateReasoning).toHaveBeenCalledTimes(1);
    const firstRequest = requests.translateReasoning.mock.calls[0][2];

    await user.click(first);
    await user.click(second);
    await waitFor(() => {
      expect(requests.cancelReasoningTranslation.mock.calls).toEqual([
        [firstRequest],
      ]);
    });

    await user.click(first);
    expect(await screen.findByText("正在翻译…")).toBeVisible();
    expect(requests.translateReasoning).toHaveBeenCalledTimes(2);
    await act(async () => resolveCancelled("迟到的译文"));
    expect(screen.queryByText("迟到的译文")).not.toBeInTheDocument();

    await user.click(second);
    await waitFor(() =>
      expect(screen.getAllByText("正在翻译…")).toHaveLength(2),
    );
    expect(requests.translateReasoning).toHaveBeenCalledTimes(2);
    await act(async () => resolveNew("重新翻译"));
    await waitFor(() =>
      expect(screen.getAllByText("重新翻译")).toHaveLength(2),
    );
  });

  it("remembers an explicit language and discards results for the previous language", async () => {
    const user = userEvent.setup();
    let resolveJapanese!: (result: string) => void;
    requests.translateReasoning
      .mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            resolveJapanese = resolve;
          }),
      )
      .mockResolvedValueOnce("Check this locally.");

    const view = render(part());
    await user.click(summary());
    const target = screen.getByRole("combobox", { name: "翻译成" });
    expect(target).toHaveValue("auto");
    await user.selectOptions(target, "ja");
    expect(requests.translateReasoning).not.toHaveBeenCalled();
    expect(localStorage.getItem(preference)).toBeNull();

    await user.click(screen.getByRole("button", { name: "开启自动翻译" }));
    expect(await screen.findByText("正在翻译…")).toBeVisible();
    expect(requests.translateReasoning).toHaveBeenNthCalledWith(
      1,
      source,
      "ja",
      expect.any(String),
      "bing",
    );
    const japaneseRequestId = requests.translateReasoning.mock.calls[0][2];

    await user.selectOptions(target, "en");
    expect(
      (await screen.findByText("Check this locally.")).closest("[lang]"),
    ).toHaveAttribute("lang", "en");
    expect(requests.cancelReasoningTranslation).toHaveBeenCalledWith(
      japaneseRequestId,
    );
    expect(requests.translateReasoning).toHaveBeenNthCalledWith(
      2,
      source,
      "en",
      expect.any(String),
      "bing",
    );
    await act(async () => resolveJapanese("古い翻訳"));
    expect(screen.queryByText("古い翻訳")).not.toBeInTheDocument();

    view.unmount();
    requests.translateReasoning.mockResolvedValueOnce("Check this locally.");
    render(part());
    await user.click(summary());
    expect(screen.getByRole("combobox", { name: "翻译成" })).toHaveValue("en");
    expect(await screen.findByText("Check this locally.")).toBeVisible();
  });

  it("requires consent for a different provider and keeps its requests and cache separate", async () => {
    const user = userEvent.setup();
    const second = "Then read the example tests.";
    const reasoning = `${source}\n\n${second}`;
    const sessionCache: AgentReasoningSessionTranslations = new Map();
    let resolveBing!: (result: string) => void;
    localStorage.setItem(preference, "true");
    requests.translateReasoning
      .mockResolvedValueOnce("先阅读示例。")
      .mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            resolveBing = resolve;
          }),
      )
      .mockResolvedValueOnce("先在本地查看示例。")
      .mockResolvedValueOnce("然后阅读示例测试。 ");
    render(
      <AgentReasoningSessionCache.Provider value={sessionCache}>
        {part(reasoning)}
      </AgentReasoningSessionCache.Provider>,
    );
    await user.click(summary());
    const service = screen.getByRole("combobox", { name: "翻译服务" });
    expect(service).toHaveValue("bing");
    await waitFor(() =>
      expect(requests.translateReasoning).toHaveBeenCalledTimes(2),
    );
    expect(screen.getByText(/先阅读示例。/u)).toBeVisible();
    expect(requests.translateReasoning).toHaveBeenNthCalledWith(
      2,
      second,
      "zh-CN",
      expect.any(String),
      "bing",
    );
    const pendingBing = requests.translateReasoning.mock.calls[1][2];

    await user.selectOptions(service, "google");
    expect(localStorage.getItem(preference)).toBe("google:disabled");
    const consent = screen.getByRole("button", { name: "开启自动翻译" });
    expect(consent).toHaveAccessibleDescription(/Google 翻译/u);
    expect(requests.cancelReasoningTranslation).toHaveBeenCalledWith(
      pendingBing,
    );
    expect(screen.getByText(source)).toBeVisible();
    await act(async () => resolveBing("不应显示的旧译文。"));
    expect(requests.translateReasoning).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(/不应显示的旧译文。/u)).not.toBeInTheDocument();

    await user.click(consent);
    expect(
      await screen.findByText(/先在本地查看示例。.*然后阅读示例测试。/u),
    ).toBeVisible();
    expect(localStorage.getItem(preference)).toBe("google:enabled");
    expect(requests.translateReasoning.mock.calls.slice(2)).toEqual([
      [source, "zh-CN", expect.any(String), "google"],
      [second, "zh-CN", expect.any(String), "google"],
    ]);
  });

  it.each(["collapse", "switch session"])(
    "cancels on %s and ignores a late result",
    async (action) => {
      const user = userEvent.setup();
      localStorage.setItem(preference, "true");
      let resolve!: (value: string) => void;
      requests.translateReasoning.mockImplementation(
        () =>
          new Promise<string>((done) => {
            resolve = done;
          }),
      );
      const pane = (active: boolean) => (
        <ViewActivityContext.Provider value={active}>
          {part()}
        </ViewActivityContext.Provider>
      );
      const view = render(pane(true));
      await user.click(summary());
      expect(await screen.findByText("正在翻译…")).toBeVisible();
      if (action === "collapse") await user.click(summary());
      else view.rerender(pane(false));
      await waitFor(() =>
        expect(requests.cancelReasoningTranslation).toHaveBeenCalledWith(
          requests.translateReasoning.mock.calls[0][2],
        ),
      );
      await act(async () => resolve("过期译文"));
      expect(screen.queryByText("过期译文")).not.toBeInTheDocument();
    },
  );

  it("leaves the live tail alone and keeps chunks within the UTF-16 request limit", async () => {
    const user = userEvent.setup();
    localStorage.setItem(preference, "true");
    requests.translateReasoning.mockResolvedValue("片段译文");
    const prefix = "x".repeat(3999);
    const text = `${prefix}🐳\n\nThe unfinished paragraph`;
    const view = render(part(text, true));
    await user.click(summary());
    await waitFor(() =>
      expect(requests.translateReasoning).toHaveBeenCalledTimes(2),
    );
    expect(
      requests.translateReasoning.mock.calls.map(([fragment]) => fragment),
    ).toEqual([prefix, "🐳"]);
    expect(
      await screen.findByText(/片段译文.*片段译文 The unfinished paragraph/),
    ).toBeVisible();

    view.rerender(part(text, false));
    await waitFor(() =>
      expect(requests.translateReasoning).toHaveBeenCalledTimes(3),
    );
    expect(requests.translateReasoning.mock.calls[2][0]).toBe(
      "The unfinished paragraph",
    );
  });
});
