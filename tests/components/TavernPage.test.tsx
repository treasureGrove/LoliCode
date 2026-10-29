import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { TavernPage } from "@/features/tavern/TavernPage";
import type {
  TavernCharacter,
  TavernSnapshot,
  TavernStory,
} from "@/lib/api/tavern";
import zh from "@/i18n/locales/zh.json";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@/lib/toast", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values: Record<string, unknown> = {}) => {
      let text = key
        .split(".")
        .reduce<unknown>(
          (data, part) => (data as Record<string, unknown>)?.[part],
          zh,
        );
      if (typeof text !== "string") return key;
      for (const [name, value] of Object.entries(values))
        text = (text as string).split(`{{${name}}}`).join(String(value));
      return text as string;
    },
    i18n: { language: "zh", resolvedLanguage: "zh" },
  }),
}));

const character: TavernCharacter = {
  id: "builtin:sillyloli",
  name: "sillyLoli",
  description: "原创犬娘",
  personality: "好奇",
  scenario: "工坊",
  firstMes: "你来啦！今天想做什么？",
  mesExample: "你好",
  systemPrompt: "扮演角色",
  postHistoryInstructions: "不要代替用户说话",
  alternateGreetings: [],
  tags: ["原创"],
  creator: "LoliCode",
  characterVersion: "1.0",
  sourceFormat: "builtin",
  hasAvatar: false,
  importedAt: 1,
};
const presets = [
  {
    id: "sillyloli",
    name: "sillyLoli",
    work: "LoliCode",
    tagline: "迷糊犬娘搭档",
    kind: "original",
    tags: ["犬娘", "创作"],
    firstMes: character.firstMes,
    added: false,
  },
  {
    id: "furina",
    name: "芙宁娜",
    work: "原神",
    tagline: "幕外生活",
    kind: "fan",
    tags: ["戏剧"],
    firstMes: "剧场见！",
    added: false,
  },
];
let stored: TavernSnapshot;
let failStory: boolean;
let failPresets: boolean;
let localEnabled: boolean;
let pauseAdd: (() => Promise<unknown>) | undefined;
beforeEach(() => {
  stored = { characters: [], stories: [] };
  failStory = false;
  failPresets = false;
  localEnabled = false;
  pauseAdd = undefined;
  Element.prototype.scrollIntoView = vi.fn();
  vi.mocked(invoke)
    .mockReset()
    .mockImplementation(async (command, args) => {
      if (command === "get_tavern_snapshot") return structuredClone(stored);
      if (command === "get_tavern_local_model")
        return {
          supported: true,
          installed: localEnabled,
          enabled: localEnabled,
          stage: localEnabled ? "running" : "notInstalled",
          downloadedBytes: 0,
          totalBytes: 6358750677,
          error: null,
          cpuFfnLayers: 0,
        };
      if (command === "get_tavern_catalog")
        return localEnabled
          ? {
              models: [
                {
                  id: "tavern-local:sbg-v2-9b-q4-16k",
                  name: "硅基女友 v2 9B · Q4_K_M · 16K",
                  channelName: "本机运行",
                },
              ],
              defaultModel: "tavern-local:sbg-v2-9b-q4-16k",
            }
          : { models: [], defaultModel: null };
      if (command === "install_tavern_local_model") {
        localEnabled = true;
        return;
      }
      if (command === "send_tavern_message") {
        const { storyId, text, modelId } = args as {
          storyId: string;
          text: string;
          modelId: string;
        };
        expect(modelId).toBe("tavern-local:sbg-v2-9b-q4-16k");
        const story = stored.stories.find((item) => item.id === storyId)!;
        story.messages.push(
          { id: "user", role: "user", text, createdAt: 3, failed: false },
          {
            id: "reply",
            role: "assistant",
            text: "来啦，坐下来聊一会儿吧。",
            createdAt: 4,
            failed: false,
          },
        );
        return structuredClone(story);
      }
      if (command === "get_tavern_presets") {
        if (failPresets) throw new Error("目录读取失败");
        return presets.map((preset) => ({
          ...preset,
          added: stored.characters.some(
            (item) => item.id === `builtin:${preset.id}`,
          ),
        }));
      }
      if (command === "add_tavern_preset") {
        await pauseAdd?.();
        expect(args).toEqual({ presetId: "sillyloli" });
        const existing = stored.characters.find(
          (item) => item.id === character.id,
        );
        if (existing) return existing;
        stored.characters.push(character);
        return character;
      }
      if (command === "create_tavern_story") {
        if (failStory) throw new Error("本地保存失败");
        const selected = stored.characters.find(
          (item) => item.id === (args as { characterId: string }).characterId,
        )!;
        const story: TavernStory = {
          id: `story-${stored.stories.length}`,
          characterId: selected.id,
          title: `与${selected.name}的新故事`,
          createdAt: 2,
          updatedAt: 2,
          isGenerating: false,
          messages: [
            {
              id: "greeting",
              role: "assistant",
              text: selected.firstMes,
              createdAt: 2,
              failed: false,
            },
          ],
        };
        stored.stories.push(story);
        return story;
      }
      throw new Error(`Unexpected command: ${command}`);
    });
});
function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <TavernPage onOpenChannels={vi.fn()} />
    </QueryClientProvider>,
  );
  return client;
}
async function openGallery(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "预设人物" }));
  const dialog = await screen.findByRole("dialog");
  await within(dialog).findByRole("button", { name: "与sillyLoli开始故事" });
  return dialog;
}
const calls = (command: string) =>
  vi.mocked(invoke).mock.calls.filter(([name]) => name === command);

describe("Tavern bundled character flow", () => {
  it("refreshes an empty model catalog after local setup and chats with the selected local model", async () => {
    const user = userEvent.setup();
    mount();
    const gallery = await openGallery(user);
    await user.click(
      within(gallery).getByRole("button", { name: "与sillyLoli开始故事" }),
    );
    const input = await screen.findByRole("textbox", { name: "故事消息" });
    expect(input).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "展开本地模型设置" }));
    await user.click(screen.getByRole("button", { name: "一键配置并启用" }));
    await waitFor(() => expect(input).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "收起本地模型设置" }));
    await user.type(input, "陪我聊一会儿。");
    await user.click(screen.getByRole("button", { name: "发送" }));
    expect(await screen.findByText("来啦，坐下来聊一会儿吧。")).toBeVisible();
    expect(stored.characters).toHaveLength(1);
    expect(stored.stories).toHaveLength(1);
    expect(calls("send_tavern_message")).toHaveLength(1);
    expect(
      vi
        .mocked(invoke)
        .mock.calls.every(([name]) => !name.includes("channel_center")),
    ).toBe(true);
  });
  it("starts from an empty library, searches and previews a card, then saves and opens its greeting without calling a model", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(
      await screen.findByRole("button", { name: "从预设人物开始" }),
    );
    const dialog = await screen.findByRole("dialog");
    const search = within(dialog).getByRole("textbox", {
      name: "搜索人物、作品或标签",
    });
    await within(dialog).findByRole("heading", { name: "芙宁娜" });
    await user.type(search, "原神");
    expect(
      within(dialog).queryByRole("heading", { name: "sillyLoli" }),
    ).not.toBeInTheDocument();
    expect(
      within(dialog).getByRole("heading", { name: "芙宁娜" }),
    ).toBeInTheDocument();
    await user.clear(search);
    await user.type(search, "不存在的人物");
    expect(within(dialog).getByRole("status")).toHaveTextContent(
      "没有找到匹配的人物",
    );
    await user.clear(search);
    await user.type(search, "犬娘");
    const card = within(dialog).getByRole("article", { name: "sillyLoli" });
    await user.click(within(card).getByText("看看开场"));
    expect(within(card).getByText(character.firstMes)).toBeVisible();
    await user.click(
      within(card).getByRole("button", { name: "与sillyLoli开始故事" }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(
      await screen.findByRole("heading", { name: "与sillyLoli的新故事" }),
    ).toBeInTheDocument();
    expect(screen.getByText(character.firstMes)).toBeVisible();
    expect(stored.characters).toHaveLength(1);
    expect(stored.stories).toHaveLength(1);
    expect(calls("send_tavern_message")).toHaveLength(0);
    expect(calls("get_tavern_avatar")).toHaveLength(0);
  });

  it("keeps existing imported cards, edited presets and stories when starting an already added character", async () => {
    const user = userEvent.setup();
    const edited = { ...character, firstMes: "用户修改的开场白" };
    stored.characters = [
      {
        ...character,
        id: "imported-card",
        name: "我的角色",
        sourceFormat: "V2",
      },
      edited,
    ];
    stored.stories = [
      {
        id: "old-story",
        characterId: "imported-card",
        title: "已有故事",
        createdAt: 1,
        updatedAt: 1,
        isGenerating: false,
        messages: [],
      },
    ];
    const client = mount();
    const dialog = await openGallery(user);
    expect(
      within(
        within(dialog).getByRole("article", { name: "sillyLoli" }),
      ).getByText("已在角色库"),
    ).toBeVisible();
    await user.click(
      within(dialog).getByRole("button", { name: "与sillyLoli开始故事" }),
    );
    await screen.findByRole("heading", { name: "与sillyLoli的新故事" });
    expect(screen.getByText(edited.firstMes)).toBeVisible();
    expect(stored.characters).toHaveLength(2);
    expect(
      client
        .getQueryData<TavernSnapshot>(["tavern", "snapshot"])
        ?.stories.some((story) => story.id === "old-story"),
    ).toBe(true);
  });

  it("retains a successfully added card if story saving fails and retries without duplicating the character", async () => {
    const user = userEvent.setup();
    failStory = true;
    mount();
    const dialog = await openGallery(user);
    await user.click(
      within(dialog).getByRole("button", { name: "与sillyLoli开始故事" }),
    );
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "本地保存失败",
    );
    expect(stored.characters).toHaveLength(1);
    expect(stored.stories).toHaveLength(0);
    failStory = false;
    await user.click(
      within(dialog).getByRole("button", { name: "与sillyLoli开始故事" }),
    );
    await screen.findByRole("heading", { name: "与sillyLoli的新故事" });
    expect(stored.characters).toHaveLength(1);
    expect(stored.stories).toHaveLength(1);
  });

  it("prevents duplicate starts while adding and recovers a failed catalog load", async () => {
    const user = userEvent.setup();
    failPresets = true;
    mount();
    await user.click(await screen.findByRole("button", { name: "预设人物" }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "预设人物暂时无法读取",
    );
    failPresets = false;
    await user.click(within(dialog).getByRole("button", { name: "重试" }));
    let release!: () => void;
    pauseAdd = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    const start = await within(dialog).findByRole("button", {
      name: "与sillyLoli开始故事",
    });
    await user.dblClick(start);
    await waitFor(() => expect(start).toBeDisabled());
    expect(calls("add_tavern_preset")).toHaveLength(1);
    expect(within(dialog).getByRole("button", { name: "关闭" })).toBeDisabled();
    await user.keyboard("{Escape}");
    expect(dialog).toBeInTheDocument();
    release();
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(stored.stories).toHaveLength(1);
  });

  it("allows browsing but blocks starting another story during generation", async () => {
    const user = userEvent.setup();
    stored.characters = [character];
    stored.stories = [
      {
        id: "active",
        characterId: character.id,
        title: "生成中的故事",
        createdAt: 1,
        updatedAt: 1,
        isGenerating: true,
        messages: [],
      },
    ];
    mount();
    await user.click(
      await screen.findByRole("button", { name: "生成中的故事" }),
    );
    const dialog = await openGallery(user);
    expect(
      within(dialog).getByRole("button", { name: "与sillyLoli开始故事" }),
    ).toBeDisabled();
    expect(within(dialog).getByRole("status")).toHaveTextContent(
      "当前故事正在生成",
    );
    expect(calls("add_tavern_preset")).toHaveLength(0);
  });
});
