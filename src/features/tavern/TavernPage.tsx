import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ConversationLoading } from "@/components/motion/ConversationLoading";
import { DRAG_REGION_ATTR, DRAG_REGION_STYLE } from "@/lib/platform";
import { useTranslation } from "react-i18next";
import {
  Archive,
  BookHeart,
  BookOpenText,
  Brain,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  Download,
  FileText,
  FolderInput,
  Globe,
  Image as ImageIcon,
  LoaderCircle,
  Mic,
  MicOff,
  MoreHorizontal,
  Paperclip,
  Plus,
  Send,
  ShieldCheck,
  Sparkles,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { WindowControlsContext } from "@/app/shell/AppPageHeader";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Spectrum } from "@/features/chat-demo/components/chatInput/Spectrum";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import {
  tavernApi,
  tavernSnapshotQuery,
  TAVERN_PRESETS_KEY,
  type TavernMessage,
  type TavernStory,
  type TavernSnapshot,
} from "@/lib/api/tavern";
import { TavernPresetGallery } from "./TavernPresetGallery";
import { TavernTranscript } from "./TavernTranscript";
import {
  exportTavernCharacterZip,
  formatOutgoingTavernMessage,
  parseTavernImportArchive,
  stopTavernReadAloud,
  useTavernBranches,
  useTavernVoiceInput,
  type TavernDraftAttachment,
} from "./tavernChatCoupling";
import companion from "@/assets/atelier/companion.png?inline";
import "./tavern-composer.css";

const TAVERN_QUERY_KEY = tavernSnapshotQuery.queryKey;
const CATALOG_QUERY_KEY = ["tavern", "catalog"] as const;

function errorText(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return String(error);
}

function upsertStory(
  stories: TavernStory[],
  story: TavernStory,
): TavernStory[] {
  return [story, ...stories.filter((item) => item.id !== story.id)].sort(
    (left, right) => right.updatedAt - left.updatedAt,
  );
}

export function TavernPage({
  isActive = true,
  characterId: controlledCharacterId,
  onCharacterChange,
  onOpenChannels,
}: {
  isActive?: boolean;
  characterId?: string | null;
  onCharacterChange?: (id: string | null) => void;
  onOpenChannels: () => void;
}) {
  const { t, i18n } = useTranslation();
  const windowControls = useContext(WindowControlsContext);
  const queryClient = useQueryClient();
  const [localCharacterId, setLocalCharacterId] = useState<string | null>(null);
  const characterId =
    controlledCharacterId === undefined
      ? localCharacterId
      : controlledCharacterId;
  const selectCharacter = useCallback(
    (id: string | null) => {
      if (controlledCharacterId === undefined) setLocalCharacterId(id);
      onCharacterChange?.(id);
    },
    [controlledCharacterId, onCharacterChange],
  );
  const [storyId, setStoryId] = useState<string | null>(null);
  const [modelId, setModelId] = useState("");
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<TavernDraftAttachment[]>([]);
  const [deepThink, setDeepThink] = useState(false);
  const [webSearch, setWebSearch] = useState(false);
  const [spotlightExpanded, setSpotlightExpanded] = useState(true);
  const [sending, setSending] = useState(false);
  const [importing, setImporting] = useState(false);
  const [showContext, setShowContext] = useState(false);
  const [showPresets, setShowPresets] = useState(false);
  const storyActionInFlight = useRef(false);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const archiveInputRef = useRef<HTMLInputElement>(null);
  const addBranchVersion = useTavernBranches((state) => state.addVersion);

  const snapshot = useQuery({
    ...tavernSnapshotQuery,
    enabled: isActive,
  });
  const catalog = useQuery({
    queryKey: CATALOG_QUERY_KEY,
    queryFn: tavernApi.getCatalog,
    staleTime: 60_000,
    retry: false,
  });

  const characters = snapshot.data?.characters ?? [];
  const stories = snapshot.data?.stories;
  const selectedCharacter =
    characters.find((item) => item.id === characterId) ?? characters[0];
  const selectedCharacterId = selectedCharacter?.id ?? null;
  const activeCharacterId = useRef(selectedCharacterId);
  activeCharacterId.current = selectedCharacterId;
  const characterStories = useMemo(
    () =>
      (stories ?? [])
        .filter((story) => story.characterId === selectedCharacterId)
        .sort((left, right) => right.updatedAt - left.updatedAt),
    [selectedCharacterId, stories],
  );
  const selectedStory =
    characterStories.find((story) => story.id === storyId) ??
    characterStories[0];
  const selectedStoryId = selectedStory?.id;
  const activeStoryId = useRef(selectedStoryId);
  activeStoryId.current = selectedStoryId;
  const avatar = useQuery({
    queryKey: ["tavern", "avatar", selectedCharacter?.id],
    queryFn: () => tavernApi.getAvatar(selectedCharacter!.id),
    enabled: Boolean(
      selectedCharacter?.hasAvatar &&
        selectedCharacter.id !== "builtin:sillyloli",
    ),
    staleTime: Infinity,
    retry: false,
  });
  const context = useQuery({
    queryKey: ["tavern", "context", selectedStoryId],
    queryFn: () => tavernApi.previewContext(selectedStoryId!),
    enabled: isActive && showContext && Boolean(selectedStoryId),
    staleTime: 10_000,
  });

  const voice = useTavernVoiceInput(
    (transcript) => {
      setDraft((prev) => (prev ? `${prev} ${transcript}` : transcript));
    },
    (message) => {
      toast.error(message);
    },
  );

  useEffect(() => {
    if (!isActive) {
      stopTavernReadAloud();
      voice.cancel();
    }
  }, [isActive, voice.cancel]);

  useEffect(() => {
    if (snapshot.isSuccess && characterId !== selectedCharacterId) {
      selectCharacter(selectedCharacterId);
    }
  }, [characterId, selectedCharacterId, selectCharacter, snapshot.isSuccess]);

  useEffect(() => {
    if (storyId && selectedStoryId !== storyId) setStoryId(null);
  }, [storyId, selectedStoryId]);

  useEffect(() => {
    setDraft("");
    setAttachments([]);
    stopTavernReadAloud();
  }, [selectedCharacterId, selectedStoryId]);

  useEffect(() => {
    const models = catalog.data?.models ?? [];
    if (models.length === 0) return;
    if (!models.some((model) => model.id === modelId)) {
      setModelId(
        (catalog.data?.defaultModel &&
          models.some((model) => model.id === catalog.data?.defaultModel) &&
          catalog.data.defaultModel) ||
          models[0].id,
      );
    }
  }, [catalog.data, modelId]);

  const handleAttachFiles = async (files: File[]) => {
    if (files.length === 0) return;
    const loaded: TavernDraftAttachment[] = [];
    for (const file of files.slice(0, 6)) {
      if (file.size > 8 * 1024 * 1024) {
        toast.error(`附件《${file.name}》超过 8MB 限制`);
        continue;
      }
      const isImage = file.type.startsWith("image/");
      try {
        if (isImage) {
          const dataUrl = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result ?? ""));
            reader.onerror = () => reject(new Error("读取图片失败"));
            reader.readAsDataURL(file);
          });
          loaded.push({
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            name: file.name,
            kind: "image",
            size: file.size,
            content: `[图片附件: ${file.name}]`,
            dataUrl,
          });
        } else {
          const textContent = await file.text();
          loaded.push({
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            name: file.name,
            kind: "text",
            size: file.size,
            content: textContent,
          });
        }
      } catch {
        toast.error(`读取附件《${file.name}》失败`);
      }
    }
    if (loaded.length > 0) {
      setAttachments((prev) => [...prev, ...loaded].slice(0, 6));
    }
  };

  const handleImportArchiveFile = async (
    event: ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !selectedCharacter) return;
    try {
      const importedStories = await parseTavernImportArchive(
        file,
        selectedCharacter.id,
        selectedCharacter.name,
      );
      queryClient.setQueryData<TavernSnapshot>(TAVERN_QUERY_KEY, (current) => {
        if (!current) return current;
        let nextStories = [...current.stories];
        for (const story of importedStories) {
          nextStories = upsertStory(nextStories, story);
        }
        return {
          ...current,
          stories: nextStories,
        };
      });
      if (importedStories[0]) {
        setStoryId(importedStories[0].id);
      }
      toast.success(`已导入 ${importedStories.length} 段对话记录`);
    } catch (error) {
      toast.error("导入对话归档失败", { description: errorText(error) });
    }
  };

  const importCharacter = async () => {
    setImporting(true);
    try {
      const path = await open({
        multiple: false,
        title: t("tavern.importTitle"),
        filters: [
          { name: "智能体人格与角色卡", extensions: ["md", "png", "json"] },
        ],
      });
      if (typeof path !== "string") return;
      const imported = await tavernApi.importCharacter(path);
      await queryClient.invalidateQueries({ queryKey: TAVERN_QUERY_KEY });
      selectCharacter(imported.id);
      setStoryId(null);
      toast.success(t("tavern.importSuccess", { name: imported.name }));
    } catch (error) {
      toast.error(t("tavern.importFailed"), { description: errorText(error) });
    } finally {
      setImporting(false);
    }
  };

  const createStory = async () => {
    if (
      !selectedCharacterId ||
      sending ||
      selectedStory?.isGenerating ||
      storyActionInFlight.current
    )
      return;
    storyActionInFlight.current = true;
    try {
      const story = await tavernApi.createStory(selectedCharacterId);
      queryClient.setQueryData(
        TAVERN_QUERY_KEY,
        (current: typeof snapshot.data) =>
          current
            ? { ...current, stories: upsertStory(current.stories, story) }
            : current,
      );
      if (activeCharacterId.current === selectedCharacterId) {
        setStoryId(story.id);
        setDraft("");
        setAttachments([]);
        setShowContext(false);
      }
    } catch (error) {
      toast.error(t("tavern.storyCreateFailed"), {
        description: errorText(error),
      });
    } finally {
      storyActionInFlight.current = false;
    }
  };

  useEffect(() => {
    const onAdd = (event: Event) => {
      if ((event as CustomEvent<"preset" | "card">).detail === "preset")
        setShowPresets(true);
      else void importCharacter();
    };
    window.addEventListener("lolicode:tavern-add", onAdd);
    return () => window.removeEventListener("lolicode:tavern-add", onAdd);
  });

  const startPreset = async (presetId: string) => {
    if (sending || selectedStory?.isGenerating)
      throw new Error(t("tavern.presets.busy"));
    await queryClient.ensureQueryData(tavernSnapshotQuery);
    const character = await tavernApi.addPreset(presetId);
    // Keep the successfully added card even if creating the story fails.
    await queryClient.cancelQueries({ queryKey: TAVERN_QUERY_KEY });
    queryClient.setQueryData<TavernSnapshot>(TAVERN_QUERY_KEY, (current) => ({
      characters: [
        character,
        ...(current?.characters ?? []).filter(
          (item) => item.id !== character.id,
        ),
      ],
      stories: current?.stories ?? [],
    }));
    void queryClient.invalidateQueries({ queryKey: TAVERN_PRESETS_KEY });
    const story = await tavernApi.createStory(character.id);
    await queryClient.cancelQueries({ queryKey: TAVERN_QUERY_KEY });
    queryClient.setQueryData<TavernSnapshot>(TAVERN_QUERY_KEY, (current) => ({
      characters: current?.characters ?? [character],
      stories: upsertStory(current?.stories ?? [], story),
    }));
    selectCharacter(character.id);
    setStoryId(story.id);
    setShowContext(false);
    setDraft("");
    setAttachments([]);
  };

  const deleteStory = async () => {
    if (
      !selectedStory ||
      sending ||
      selectedStory.isGenerating ||
      storyActionInFlight.current
    )
      return;
    storyActionInFlight.current = true;
    try {
      await tavernApi.deleteStory(selectedStory.id);
      await queryClient.invalidateQueries({ queryKey: TAVERN_QUERY_KEY });
      toast.success(t("tavern.storyDeleted"));
    } catch (error) {
      toast.error(t("tavern.storyDeleteFailed"), {
        description: errorText(error),
      });
    } finally {
      storyActionInFlight.current = false;
    }
  };

  const send = useCallback(
    async (overrideText?: string) => {
      const usingOverride = typeof overrideText === "string";
      const hasContent = usingOverride
        ? Boolean(overrideText.trim())
        : Boolean(draft.trim() || attachments.length > 0);
      if (!selectedStory || !hasContent || !modelId || sending) return;

      const rawDraft = usingOverride
        ? overrideText.trim()
        : draft.trim() || "请查看附件内容并回应。";
      const outgoingText = formatOutgoingTavernMessage({
        text: rawDraft,
        attachments: usingOverride ? [] : attachments,
        deepThink,
        webSearch,
      });
      const prevAttachments = usingOverride ? [] : attachments;
      if (!usingOverride) {
        setDraft("");
        setAttachments([]);
      }
      stopTavernReadAloud();
      setSending(true);
      try {
        const story = await tavernApi.sendMessage(
          selectedStory.id,
          outgoingText,
          modelId,
        );
        queryClient.setQueryData(
          TAVERN_QUERY_KEY,
          (current: typeof snapshot.data) =>
            current
              ? { ...current, stories: upsertStory(current.stories, story) }
              : current,
        );
        await queryClient.invalidateQueries({
          queryKey: ["usage"],
          refetchType: "active",
        });
      } catch (error) {
        if (!usingOverride && activeStoryId.current === selectedStory.id) {
          setDraft(rawDraft);
          setAttachments(prevAttachments);
        }
        await queryClient.invalidateQueries({ queryKey: TAVERN_QUERY_KEY });
        toast.error(t("tavern.generationFailed"), {
          description: errorText(error),
        });
      } finally {
        setSending(false);
      }
    },
    [
      attachments,
      deepThink,
      draft,
      modelId,
      queryClient,
      selectedStory,
      sending,
      snapshot.data,
      t,
      webSearch,
    ],
  );

  const handleQuickPrompt = useCallback(
    (prompt: string) => {
      if (!modelId) {
        setDraft(prompt);
        return;
      }
      void send(prompt);
    },
    [modelId, send],
  );

  const handleRegenerateMessage = useCallback(
    async (assistantMessage: TavernMessage, precedingUserText: string) => {
      if (!selectedStory || !modelId || sending || !precedingUserText.trim())
        return;
      const targetStoryId = selectedStory.id;
      const originalMessages = selectedStory.messages;
      stopTavernReadAloud();
      setSending(true);
      try {
        const updatedStory = await tavernApi.sendMessage(
          targetStoryId,
          precedingUserText,
          modelId,
        );
        const latestAssistant = [...updatedStory.messages]
          .reverse()
          .find((m) => m.role === "assistant");
        if (latestAssistant) {
          addBranchVersion(
            `${targetStoryId}:${assistantMessage.id}`,
            assistantMessage.text,
            latestAssistant.text,
          );
          const mergedStory: TavernStory = {
            ...updatedStory,
            messages: originalMessages.map((msg) =>
              msg.id === assistantMessage.id
                ? { ...msg, text: latestAssistant.text, failed: false }
                : msg,
            ),
          };
          queryClient.setQueryData(
            TAVERN_QUERY_KEY,
            (current: typeof snapshot.data) =>
              current
                ? {
                    ...current,
                    stories: upsertStory(current.stories, mergedStory),
                  }
                : current,
          );
        }
      } catch (error) {
        toast.error(t("tavern.generationFailed"), {
          description: errorText(error),
        });
      } finally {
        setSending(false);
      }
    },
    [
      addBranchVersion,
      modelId,
      queryClient,
      selectedStory,
      sending,
      snapshot,
      t,
    ],
  );

  const handleEditUserMessage = useCallback(
    async (
      userMessage: TavernMessage,
      nextText: string,
      followingAssistantMessage?: TavernMessage,
    ) => {
      if (!selectedStory || !modelId || sending || !nextText.trim()) return;
      const targetStoryId = selectedStory.id;
      const originalMessages = selectedStory.messages;
      const outgoing = formatOutgoingTavernMessage({
        text: nextText,
        attachments: [],
        deepThink,
        webSearch,
      });
      addBranchVersion(
        `${targetStoryId}:${userMessage.id}`,
        userMessage.text,
        outgoing,
      );
      stopTavernReadAloud();
      setSending(true);
      try {
        const updatedStory = await tavernApi.sendMessage(
          targetStoryId,
          outgoing,
          modelId,
        );
        const latestAssistant = [...updatedStory.messages]
          .reverse()
          .find((m) => m.role === "assistant");
        if (followingAssistantMessage && latestAssistant) {
          addBranchVersion(
            `${targetStoryId}:${followingAssistantMessage.id}`,
            followingAssistantMessage.text,
            latestAssistant.text,
          );
        }
        const mergedStory: TavernStory = {
          ...updatedStory,
          messages: originalMessages.map((msg) => {
            if (msg.id === userMessage.id) {
              return { ...msg, text: outgoing, failed: false };
            }
            if (
              followingAssistantMessage &&
              latestAssistant &&
              msg.id === followingAssistantMessage.id
            ) {
              return { ...msg, text: latestAssistant.text, failed: false };
            }
            return msg;
          }),
        };
        queryClient.setQueryData(
          TAVERN_QUERY_KEY,
          (current: typeof snapshot.data) =>
            current
              ? {
                  ...current,
                  stories: upsertStory(current.stories, mergedStory),
                }
              : current,
        );
      } catch (error) {
        toast.error(t("tavern.generationFailed"), {
          description: errorText(error),
        });
      } finally {
        setSending(false);
      }
    },
    [
      addBranchVersion,
      deepThink,
      modelId,
      queryClient,
      selectedStory,
      sending,
      snapshot,
      t,
      webSearch,
    ],
  );

  const onComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      void send();
    }
  };

  const modelOptions = catalog.data?.models ?? [];
  const selectedModelOption = modelOptions.find((m) => m.id === modelId);
  const isLocalZeroQuota = modelId.startsWith("tavern-local:");
  const isFreeChannelModel = Boolean(selectedModelOption?.isFree);
  const storyCharacter = selectedCharacter;
  const avatarUrl =
    selectedCharacter?.id === "builtin:sillyloli"
      ? companion
      : avatar.data?.dataUrl;

  const characterBio = useMemo(() => {
    if (!storyCharacter) return "";
    const parts = [
      storyCharacter.personality?.trim(),
      storyCharacter.scenario?.trim(),
      storyCharacter.description?.trim(),
    ].filter(Boolean);
    return (
      parts[0] ||
      "角色设定与世界书上下文已装载，选择模式或发送第一句话即可推进对话。"
    );
  }, [storyCharacter]);

  const addCharacterMenu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="添加"
          title="添加或导入角色"
          className="wb-composer-add"
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start">
        <DropdownMenuItem onSelect={() => setShowPresets(true)}>
          {t("tavern.presets.title")}
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={importing}
          onSelect={() => void importCharacter()}
        >
          {t("tavern.importCard")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  const isTyping = sending || selectedStory?.isGenerating;
  const statusText = isTyping ? t("tavern.typing") : selectedStory?.title;

  return (
    <div
      id={isActive ? "main-content" : undefined}
      className="lolicode-agent-page lolicode-workbench wb-resizable-layout wb-unified tavern-workbench"
    >
      <main className="wb-main">
        <div className="wb-chat-surface">
          <header
            className="wb-titlebar"
            {...DRAG_REGION_ATTR}
            style={DRAG_REGION_STYLE as CSSProperties}
          >
            {storyCharacter && (
              <span className="tavern-titlebar-avatar" aria-hidden="true">
                {avatarUrl ? (
                  <img src={avatarUrl} alt="" decoding="async" />
                ) : (
                  storyCharacter.name.slice(0, 1)
                )}
              </span>
            )}
            <div
              className="wb-titlebar-heading"
              data-workspace-entry
              {...DRAG_REGION_ATTR}
            >
              <h1 {...DRAG_REGION_ATTR}>
                {storyCharacter?.name ??
                  (i18n.language.startsWith("zh")
                    ? "选择好友"
                    : "Choose a friend")}
              </h1>
            </div>
            {statusText && (
              <span
                className={cn(
                  "tavern-titlebar-story truncate",
                  isTyping && "is-typing",
                )}
                role="status"
                {...DRAG_REGION_ATTR}
              >
                <span className="truncate">{statusText}</span>
              </span>
            )}
            <span className="flex-1" {...DRAG_REGION_ATTR} />
            <div
              className="flex shrink-0 items-center gap-1"
              style={{ WebkitAppRegion: "no-drag" } as CSSProperties}
            >
              {selectedCharacter && !selectedStory && addCharacterMenu}
              <button
                type="button"
                aria-label="打开对话菜单"
                title="对话菜单与故事管理"
                onClick={() => setShowContext(true)}
                className="wb-icon-button"
              >
                <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
            {windowControls && (
              <div
                className="wb-native-controls"
                style={{ WebkitAppRegion: "no-drag" } as CSSProperties}
              >
                {windowControls}
              </div>
            )}
          </header>

          {storyCharacter && selectedStory && (
            <div className="tavern-spotlight-shell">
              {spotlightExpanded && (
                <div className="tavern-spotlight-card">
                  <div className="min-w-0 flex-1">
                    <span className="tavern-spotlight-eyebrow">
                      <Sparkles className="h-3 w-3" aria-hidden="true" />
                      <span>
                        CHARACTER STUDIO ·{" "}
                        {storyCharacter.creator ||
                          storyCharacter.sourceFormat ||
                          "ROLEPLAY"}
                      </span>
                    </span>
                    <p className="tavern-spotlight-bio">{characterBio}</p>
                    <div className="tavern-spotlight-tags">
                      {(storyCharacter.tags ?? []).slice(0, 4).map((tag) => (
                        <span key={tag} className="tavern-gold-tag">
                          {tag}
                        </span>
                      ))}
                      {storyCharacter.characterVersion && (
                        <span className="rounded-full border border-white/20 bg-black/20 px-2 py-0.5 text-[10px] text-white/85">
                          v{storyCharacter.characterVersion}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="tavern-spotlight-emblem" aria-hidden="true">
                    <div className="tavern-spotlight-avatar">
                      {avatarUrl ? (
                        <img src={avatarUrl} alt="" decoding="async" />
                      ) : (
                        <BookHeart className="h-6 w-6 text-[#f3dbb0]" />
                      )}
                    </div>
                    <span className="tavern-spotlight-caption">
                      STUDIO ♡ TAVERN
                    </span>
                  </div>
                </div>
              )}
              <div className="tavern-community-ribbon">
                <div className="tavern-community-ribbon-text">
                  <span>✦ MAKE SOMETHING LOVELY</span>
                  <span aria-hidden="true">·</span>
                  <span>世界书与角色记忆同步</span>
                  <span aria-hidden="true">·</span>
                  <span>支持多分支切换 / 深度思考 / 语音朗读</span>
                </div>
                <button
                  type="button"
                  onClick={() => setSpotlightExpanded((prev) => !prev)}
                  className="tavern-community-ribbon-toggle inline-flex items-center gap-1"
                >
                  {spotlightExpanded ? (
                    <>
                      <span>收起设定卡</span>
                      <ChevronUp className="h-3 w-3" aria-hidden="true" />
                    </>
                  ) : (
                    <>
                      <span>展开设定卡</span>
                      <ChevronDown className="h-3 w-3" aria-hidden="true" />
                    </>
                  )}
                </button>
              </div>
            </div>
          )}

          {catalog.error && (
            <div className="wb-notice flex items-center gap-2 rounded-xl border border-warning/30 bg-warning/5 px-3 py-2 text-xs text-fg-2">
              <CircleAlert className="h-4 w-4 shrink-0 text-warning" />
              <span className="min-w-0 flex-1">{errorText(catalog.error)}</span>
              <button
                type="button"
                className="font-medium text-action-text"
                onClick={onOpenChannels}
              >
                {t("tavern.configureModels")}
              </button>
            </div>
          )}

          {selectedStory && (selectedStory.messages.length > 0 || sending) ? (
            <TavernTranscript
              key={selectedStory.id}
              active={isActive}
              storyId={selectedStory.id}
              avatarUrl={avatarUrl}
              characterName={storyCharacter?.name}
              alternateGreetings={storyCharacter?.alternateGreetings}
              messages={selectedStory.messages}
              sending={sending}
              onQuickPrompt={handleQuickPrompt}
              onRegenerateMessage={handleRegenerateMessage}
              onEditUserMessage={handleEditUserMessage}
            />
          ) : (
            <div className="wb-empty">
              {snapshot.isPending ? (
                <ConversationLoading label={t("common.loading")} />
              ) : !selectedStory ? (
                <div className="wb-empty-content">
                  <div className="wb-welcome-mark">
                    {avatarUrl ? (
                      <img src={avatarUrl} alt="" />
                    ) : (
                      <Sparkles aria-hidden="true" />
                    )}
                  </div>
                  <span className="wb-welcome-eyebrow">
                    CHARACTER WORKSPACE
                  </span>
                  <h2>{selectedCharacter?.name ?? t("tavern.welcomeTitle")}</h2>
                  <p>
                    {selectedCharacter
                      ? t("tavern.startStoryHint")
                      : t("tavern.emptyLibraryHint")}
                  </p>
                  {selectedCharacter ? (
                    <Button
                      className="wb-primary wb-welcome-action"
                      onClick={() => void createStory()}
                      disabled={sending}
                    >
                      <Plus className="h-4 w-4" />
                      {t("tavern.newStory")}
                    </Button>
                  ) : (
                    <div className="mt-4 flex flex-wrap justify-center gap-3">
                      <Button
                        className="wb-primary wb-welcome-action"
                        onClick={() => setShowPresets(true)}
                      >
                        <BookHeart className="h-4 w-4" />
                        {t("tavern.presets.choose")}
                      </Button>
                      <Button
                        variant="outline"
                        className="h-[45px] rounded-[15px] px-5"
                        onClick={() => void importCharacter()}
                        disabled={importing}
                      >
                        <Upload className="h-4 w-4" />
                        {t("tavern.importCard")}
                      </Button>
                    </div>
                  )}
                </div>
              ) : (
                <div className="wb-empty-content">
                  <p>{t("tavern.emptyStory")}</p>
                </div>
              )}
            </div>
          )}

          <div className="wb-composer-area tavern-composer-area">
            {selectedStory ? (
              <div
                className="wb-composer tavern-composer"
                data-companion-surface={`tavern-composer-${selectedStory.id}`}
                data-companion-dock-id={`tavern-composer-${selectedStory.id}`}
                data-companion-rest="lie"
              >
                {attachments.length > 0 && (
                  <div className="tavern-composer-attachments">
                    {attachments.map((item) => (
                      <div key={item.id} className="wb-composer-document">
                        {item.kind === "image" ? (
                          <ImageIcon className="h-3.5 w-3.5 text-action-text" />
                        ) : (
                          <FileText className="h-3.5 w-3.5 text-action-text" />
                        )}
                        <span className="max-w-[160px] truncate text-xs">
                          {item.name}
                        </span>
                        <button
                          type="button"
                          aria-label={`移除附件 ${item.name}`}
                          onClick={() =>
                            setAttachments((prev) =>
                              prev.filter((att) => att.id !== item.id),
                            )
                          }
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                {voice.status === "recording" && (
                  <div className="tavern-composer-spectrum">
                    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-action-text">
                      <span className="h-2 w-2 animate-pulse rounded-full bg-danger" />
                      录音中 {voice.seconds}s
                    </span>
                    <div className="min-w-0 flex-1">
                      <Spectrum getAnalyser={voice.getAnalyser} />
                    </div>
                  </div>
                )}
                <textarea
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={onComposerKeyDown}
                  onPaste={(event) => {
                    const files = Array.from(event.clipboardData?.files ?? []);
                    if (files.length > 0) {
                      event.preventDefault();
                      void handleAttachFiles(files);
                    }
                  }}
                  placeholder={t("tavern.inputPlaceholder", {
                    name: storyCharacter?.name ?? "",
                  })}
                  aria-label={t("tavern.messageInput")}
                  disabled={sending || modelOptions.length === 0}
                  className="tavern-composer-input block max-h-[210px] w-full resize-y border-0 bg-transparent text-fg-1 outline-none placeholder:text-fg-3 disabled:opacity-60"
                />
                <div className="wb-composer-toolbar tavern-composer-toolbar flex flex-wrap items-center">
                  {addCharacterMenu}
                  <div className="wb-composer-model">
                    <select
                      id="tavern-model"
                      value={modelId}
                      onChange={(event) => setModelId(event.target.value)}
                      disabled={modelOptions.length === 0 || sending}
                      aria-label={t("tavern.model")}
                      className="h-8 w-full min-w-0 rounded-lg border-0 bg-transparent px-2 text-xs text-fg-2 outline-none hover:bg-subtle disabled:opacity-60"
                    >
                      {modelOptions.length === 0 ? (
                        <option value="">{t("tavern.noModels")}</option>
                      ) : (
                        modelOptions.map((model) => (
                          <option key={model.id} value={model.id}>
                            {model.channelName} · {model.name}
                          </option>
                        ))
                      )}
                    </select>
                  </div>
                  {selectedModelOption && (
                    <span
                      title={
                        isLocalZeroQuota
                          ? "本机内置离线模型运行，完全免费，不消耗任何在线额度"
                          : isFreeChannelModel
                            ? "免费公共渠道模型，不消耗个人 API 额度"
                            : "走渠道与模型中配置的共享模型接口"
                      }
                      className="tavern-quota-chip"
                    >
                      <ShieldCheck className="h-3 w-3" />
                      {isLocalZeroQuota
                        ? "本机离线 · 0 额度"
                        : isFreeChannelModel
                          ? "免费渠道 · 0 额度"
                          : "共享渠道"}
                    </span>
                  )}
                  <button
                    type="button"
                    aria-label="深度思考"
                    aria-pressed={deepThink}
                    disabled={sending || modelOptions.length === 0}
                    onClick={() => setDeepThink((v) => !v)}
                    title="开启后角色将先推演内心活动与情境逻辑，再给出正式回应"
                    className="tavern-composer-pill"
                  >
                    <Brain className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>深度思考</span>
                  </button>
                  <button
                    type="button"
                    aria-label="联网搜索"
                    aria-pressed={webSearch}
                    disabled={sending || modelOptions.length === 0}
                    onClick={() => setWebSearch((v) => !v)}
                    title="开启后支持结合外部背景知识并展示网页引用角标"
                    className="tavern-composer-pill"
                  >
                    <Globe className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>联网搜索</span>
                  </button>
                  {catalog.isSuccess && modelOptions.length === 0 && (
                    <Button size="sm" variant="quiet" onClick={onOpenChannels}>
                      {t("tavern.configureModels")}
                    </Button>
                  )}
                  <span className="wb-toolbar-spacer flex-1" />
                  <input
                    ref={attachmentInputRef}
                    type="file"
                    multiple
                    hidden
                    accept=".txt,.md,.json,.csv,.py,.ts,.tsx,.js,.rs,.html,.css,.png,.jpg,.jpeg,.webp"
                    onChange={(event) => {
                      const files = Array.from(event.target.files ?? []);
                      event.target.value = "";
                      void handleAttachFiles(files);
                    }}
                  />
                  <button
                    type="button"
                    aria-label="上传参考附件"
                    title="上传文件或图片作为对话上下文"
                    disabled={sending || modelOptions.length === 0}
                    onClick={() => attachmentInputRef.current?.click()}
                    className="wb-icon-button"
                  >
                    <Paperclip className="h-4 w-4" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    aria-label={
                      voice.status === "recording"
                        ? "停止录音并转写"
                        : "语音输入"
                    }
                    aria-pressed={voice.status === "recording"}
                    title={
                      voice.status === "recording"
                        ? "点击完成录音并转写文字"
                        : "语音输入（实时频谱）"
                    }
                    disabled={sending || modelOptions.length === 0}
                    onClick={() => void voice.toggle()}
                    className={cn(
                      "wb-icon-button",
                      voice.status === "recording" &&
                        "bg-action/15 text-action-text",
                    )}
                  >
                    {voice.status === "transcribing" ? (
                      <LoaderCircle
                        className="h-4 w-4 animate-spin"
                        aria-hidden="true"
                      />
                    ) : voice.status === "recording" ? (
                      <MicOff className="h-4 w-4" aria-hidden="true" />
                    ) : (
                      <Mic className="h-4 w-4" aria-hidden="true" />
                    )}
                  </button>
                  <Button
                    size="sm"
                    className="wb-primary wb-send-button"
                    disabled={
                      (!draft.trim() && attachments.length === 0) ||
                      sending ||
                      !modelId
                    }
                    onClick={() => void send()}
                  >
                    <Send className="h-4 w-4" aria-hidden="true" />
                    {t("tavern.send")}
                  </Button>
                </div>
              </div>
            ) : snapshot.isPending ? (
              <div
                aria-hidden="true"
                className="tavern-composer-placeholder h-[120px]"
              />
            ) : (
              <p className="tavern-composer-hint text-center text-xs text-fg-3">
                {catalog.isLoading
                  ? t("tavern.loadingModels")
                  : catalog.error
                    ? t("tavern.configureModelsHint")
                    : t("tavern.selectStoryHint")}
              </p>
            )}
          </div>
        </div>
      </main>
      <Sheet open={isActive && showContext} onOpenChange={setShowContext}>
        <SheetContent
          closeLabel="关闭对话菜单"
          width={420}
          dismissOnOutsideClick
        >
          <div className="border-b border-border px-5 py-5">
            <SheetTitle>对话菜单</SheetTitle>
            <SheetDescription className="sr-only">
              {t("tavern.stories")} · {t("tavern.contextPreview")}
            </SheetDescription>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-5">
            {selectedCharacter && (
              <section
                className="mb-5 border-b border-border pb-4"
                aria-label={t("tavern.stories")}
              >
                <div className="mb-2 flex items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold">
                    {t("tavern.stories")}
                  </h3>
                  <Button
                    size="sm"
                    variant="quiet"
                    onClick={() => void createStory()}
                    disabled={sending || selectedStory?.isGenerating}
                  >
                    <Plus className="h-4 w-4" />
                    {t("tavern.newStory")}
                  </Button>
                </div>
                {characterStories.length === 0 && (
                  <p className="text-sm text-fg-3">{t("tavern.noStories")}</p>
                )}
                {characterStories.map((story) => (
                  <button
                    key={story.id}
                    type="button"
                    aria-current={
                      story.id === selectedStoryId ? "true" : undefined
                    }
                    className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm hover:bg-subtle aria-[current=true]:bg-subtle"
                    onClick={() => {
                      setStoryId(story.id);
                      setDraft("");
                      setAttachments([]);
                      setShowContext(false);
                    }}
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {story.title}
                    </span>
                    {story.isGenerating && (
                      <LoaderCircle
                        className="h-4 w-4 animate-spin text-action-text"
                        aria-hidden="true"
                      />
                    )}
                  </button>
                ))}
                {selectedStory && (
                  <Button
                    size="sm"
                    variant="quiet"
                    className="mt-2"
                    disabled={sending || selectedStory.isGenerating}
                    onClick={() => void deleteStory()}
                  >
                    <Trash2 className="h-4 w-4" />
                    {t("tavern.deleteStory")}
                  </Button>
                )}
              </section>
            )}
            {selectedCharacter && (
              <section
                className="mb-5 border-b border-border pb-4"
                aria-label="对话归档与备份"
              >
                <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
                  <Archive className="h-4 w-4" aria-hidden="true" />
                  对话归档与备份 (ZIP)
                </h3>
                <p className="mb-3 text-xs leading-5 text-fg-3">
                  支持将当前角色卡、多分支故事与推理记录完整打包导出为
                  ZIP，或导入历史归档。
                </p>
                <input
                  ref={archiveInputRef}
                  type="file"
                  hidden
                  accept=".zip,.json"
                  onChange={(event) => void handleImportArchiveFile(event)}
                />
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={characterStories.length === 0}
                    onClick={() =>
                      exportTavernCharacterZip({
                        character: selectedCharacter,
                        stories: characterStories,
                      })
                    }
                  >
                    <Download className="h-4 w-4" />
                    导出对话归档 ZIP
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={sending}
                    onClick={() => archiveInputRef.current?.click()}
                  >
                    <FolderInput className="h-4 w-4" />
                    导入对话归档 ZIP
                  </Button>
                </div>
              </section>
            )}
            <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold">
              <BookOpenText className="h-4 w-4" aria-hidden="true" />
              {t("tavern.contextPreview")}
            </h3>
            {!selectedStory ? (
              <p className="text-sm text-fg-3">请先选择好友</p>
            ) : context.isLoading ? (
              <p className="text-sm text-fg-3">{t("tavern.loadingContext")}</p>
            ) : context.error ? (
              <p className="text-sm text-danger">{errorText(context.error)}</p>
            ) : context.data ? (
              <div className="space-y-3 text-sm text-fg-2">
                <p>
                  {t("tavern.worldInfoIncluded", {
                    count: context.data.includedEntries.length,
                    chars: context.data.worldInfoChars,
                  })}
                </p>
                <p>
                  {t("tavern.worldInfoExcluded", {
                    count: context.data.excludedEntries.length,
                  })}
                </p>
                {context.data.includedEntries.length > 0 && (
                  <p>
                    {t("tavern.includedEntries", {
                      entries: context.data.includedEntries.join("、"),
                    })}
                  </p>
                )}
                {context.data.excludedEntries.length > 0 && (
                  <p>
                    {t("tavern.excludedEntries", {
                      entries: context.data.excludedEntries.join("、"),
                    })}
                  </p>
                )}
                <details className="rounded-lg border border-border bg-subtle/60 p-3">
                  <summary className="cursor-pointer font-medium">
                    {t("tavern.promptDetails")}
                  </summary>
                  <pre className="mt-3 whitespace-pre-wrap break-words font-sans text-xs leading-5">
                    {context.data.preHistory}
                    {context.data.postHistory
                      ? `\n\n${context.data.postHistory}`
                      : ""}
                  </pre>
                </details>
              </div>
            ) : null}
          </div>
        </SheetContent>
      </Sheet>
      <TavernPresetGallery
        open={isActive && showPresets}
        onOpenChange={setShowPresets}
        onStart={startPreset}
        busy={sending || Boolean(selectedStory?.isGenerating)}
      />
    </div>
  );
}
