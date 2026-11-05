import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  BookHeart,
  BookOpenText,
  CircleAlert,
  Clock3,
  LoaderCircle,
  MoreHorizontal,
  Plus,
  Send,
  Sparkles,
  Trash2,
  Upload,
} from "lucide-react";
import { AppPageHeader } from "@/app/shell/AppPageHeader";
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
import { toast } from "@/lib/toast";
import {
  tavernApi,
  TAVERN_PRESETS_KEY,
  type TavernStory,
  type TavernSnapshot,
} from "@/lib/api/tavern";
import { TavernPresetGallery } from "./TavernPresetGallery";
import companion from "@/assets/atelier/companion.png";
import { cn } from "@/lib/utils";

const TAVERN_QUERY_KEY = ["tavern", "snapshot"] as const;
const CATALOG_QUERY_KEY = ["tavern", "catalog"] as const;

function errorText(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return String(error);
}

function formatMessageTime(timestamp: number, locale: string): string {
  return new Date(timestamp).toLocaleTimeString(locale, {
    hour: "2-digit",
    minute: "2-digit",
  });
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
  const [sending, setSending] = useState(false);
  const [importing, setImporting] = useState(false);
  const [showContext, setShowContext] = useState(false);
  const [showPresets, setShowPresets] = useState(false);
  const messageEndRef = useRef<HTMLDivElement>(null);
  const storyActionInFlight = useRef(false);

  const snapshot = useQuery({
    queryKey: TAVERN_QUERY_KEY,
    queryFn: tavernApi.getSnapshot,
  });
  const catalog = useQuery({
    queryKey: CATALOG_QUERY_KEY,
    queryFn: tavernApi.getCatalog,
    staleTime: 60_000,
    retry: false,
  });

  const characters = snapshot.data?.characters ?? [];
  const stories = snapshot.data?.stories ?? [];
  const selectedCharacter =
    characters.find((item) => item.id === characterId) ?? characters[0];
  const selectedCharacterId = selectedCharacter?.id ?? null;
  const activeCharacterId = useRef(selectedCharacterId);
  activeCharacterId.current = selectedCharacterId;
  const characterStories = stories
    .filter((story) => story.characterId === selectedCharacterId)
    .sort((left, right) => right.updatedAt - left.updatedAt);
  const selectedStory =
    characterStories.find((story) => story.id === storyId) ??
    characterStories[0];
  const selectedStoryId = selectedStory?.id;
  const activeStoryId = useRef(selectedStoryId);
  activeStoryId.current = selectedStoryId;
  const avatar = useQuery({
    queryKey: ["tavern", "avatar", selectedCharacter?.id],
    queryFn: () => tavernApi.getAvatar(selectedCharacter!.id),
    enabled: Boolean(selectedCharacter?.hasAvatar),
    staleTime: Infinity,
    retry: false,
  });
  const context = useQuery({
    queryKey: ["tavern", "context", selectedStoryId],
    queryFn: () => tavernApi.previewContext(selectedStoryId!),
    enabled: isActive && showContext && Boolean(selectedStoryId),
    staleTime: 10_000,
  });

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

  useEffect(() => {
    messageEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [selectedStory?.id, selectedStory?.messages.length]);

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
    if (!isActive) return;
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
    await queryClient.ensureQueryData({
      queryKey: TAVERN_QUERY_KEY,
      queryFn: tavernApi.getSnapshot,
    });
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

  const send = async () => {
    if (!selectedStory || !draft.trim() || !modelId || sending) return;
    const text = draft.trim();
    setDraft("");
    setSending(true);
    try {
      const story = await tavernApi.sendMessage(
        selectedStory.id,
        text,
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
      if (activeStoryId.current === selectedStory.id) setDraft(text);
      await queryClient.invalidateQueries({ queryKey: TAVERN_QUERY_KEY });
      toast.error(t("tavern.generationFailed"), {
        description: errorText(error),
      });
    } finally {
      setSending(false);
    }
  };

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

  const locale = i18n.resolvedLanguage ?? i18n.language;
  const modelOptions = catalog.data?.models ?? [];
  const storyCharacter = selectedCharacter;
  const avatarUrl =
    selectedCharacter?.id === "builtin:sillyloli"
      ? companion
      : avatar.data?.dataUrl;
  const addCharacterMenu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="添加"
          title="添加"
          className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-fg-2 hover:bg-subtle"
        >
          <Plus className="h-5 w-5" aria-hidden="true" />
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

  return (
    <div
      id={isActive ? "main-content" : undefined}
      className="flex min-h-0 flex-1 flex-col"
    >
      <AppPageHeader
        title={
          storyCharacter?.name ??
          (i18n.language.startsWith("zh") ? "选择好友" : "Choose a friend")
        }
        subtitle={
          sending || selectedStory?.isGenerating
            ? i18n.language.startsWith("zh")
              ? "对方正在输入..."
              : "Typing..."
            : selectedStory?.title
        }
        actions={
          <div className="flex items-center gap-2">
            {selectedCharacter && !selectedStory && addCharacterMenu}
            <button
              type="button"
              aria-label="打开对话菜单"
              title="对话菜单"
              onClick={() => setShowContext(true)}
              className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-fg-2 hover:bg-subtle hover:text-fg-1"
            >
              <MoreHorizontal className="h-5 w-5" aria-hidden="true" />
            </button>
          </div>
        }
      />

      <div className="flex min-h-0 flex-1">
        <section className="flex min-w-0 flex-1 flex-col overflow-hidden bg-surface">
          {catalog.error && (
            <div className="mx-4 mt-3 flex items-center gap-2 rounded-xl border border-warning/30 bg-warning/5 px-3 py-2 text-xs text-fg-2">
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

          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 lg:px-8">
            {snapshot.isPending ? (
              <div
                role="status"
                className="flex h-full items-center justify-center gap-2 text-sm text-fg-3"
              >
                <LoaderCircle
                  className="h-4 w-4 animate-spin"
                  aria-hidden="true"
                />
                {t("common.loading")}
              </div>
            ) : !selectedStory ? (
              <div className="flex h-full min-h-[300px] flex-col items-center justify-center text-center">
                <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl border border-border bg-subtle text-action-text">
                  {avatarUrl ? (
                    <img
                      src={avatarUrl}
                      alt=""
                      className="h-full w-full rounded-2xl object-cover"
                    />
                  ) : (
                    <Sparkles className="h-7 w-7" />
                  )}
                </div>
                <h3 className="text-lg font-semibold">
                  {selectedCharacter?.name ?? t("tavern.welcomeTitle")}
                </h3>
                <p className="mt-2 max-w-md text-sm leading-6 text-fg-3">
                  {selectedCharacter
                    ? t("tavern.startStoryHint")
                    : t("tavern.emptyLibraryHint")}
                </p>
                {selectedCharacter ? (
                  <Button
                    className="mt-5"
                    onClick={() => void createStory()}
                    disabled={sending}
                  >
                    <Plus className="h-4 w-4" />
                    {t("tavern.newStory")}
                  </Button>
                ) : (
                  <div className="mt-5 flex flex-wrap justify-center gap-2">
                    <Button onClick={() => setShowPresets(true)}>
                      <BookHeart className="h-4 w-4" />
                      {t("tavern.presets.choose")}
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => void importCharacter()}
                      disabled={importing}
                    >
                      <Upload className="h-4 w-4" />
                      {t("tavern.importCard")}
                    </Button>
                  </div>
                )}
              </div>
            ) : selectedStory.messages.length === 0 ? (
              <div className="flex h-full items-center justify-center text-sm text-fg-3">
                {t("tavern.emptyStory")}
              </div>
            ) : (
              <div className="mx-auto flex max-w-3xl flex-col gap-5">
                {selectedStory.messages.map((message) => (
                  <article
                    key={message.id}
                    className={cn(
                      "flex gap-3",
                      message.role === "user" && "flex-row-reverse",
                    )}
                  >
                    <div
                      className={cn(
                        "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full border border-border bg-subtle text-xs font-medium text-fg-2",
                        message.role === "user" &&
                          "bg-action/10 text-action-text",
                      )}
                    >
                      {message.role === "assistant" && avatarUrl ? (
                        <img
                          src={avatarUrl}
                          alt=""
                          className="h-full w-full object-cover"
                        />
                      ) : message.role === "assistant" ? (
                        <BookHeart className="h-4 w-4" />
                      ) : (
                        t("tavern.youShort")
                      )}
                    </div>
                    <div
                      className={cn(
                        "min-w-0 max-w-[min(82%,680px)] rounded-2xl border border-border bg-subtle/65 px-4 py-3",
                        message.role === "user" && "bg-action/10",
                        message.failed && "border-danger/40",
                      )}
                    >
                      <div className="mb-1 flex items-center gap-2 text-[11px] text-fg-3">
                        <span className="font-medium text-fg-2">
                          {message.role === "assistant"
                            ? storyCharacter?.name
                            : t("tavern.you")}
                        </span>
                        <Clock3 className="h-3 w-3" />
                        <time>
                          {formatMessageTime(message.createdAt, locale)}
                        </time>
                        {message.failed && (
                          <span className="text-danger">
                            {t("tavern.generationFailedShort")}
                          </span>
                        )}
                      </div>
                      <p className="whitespace-pre-wrap break-words text-sm leading-7 text-fg-1">
                        {message.text}
                      </p>
                    </div>
                  </article>
                ))}
                {sending && (
                  <div className="flex items-center gap-2 self-start rounded-full border border-border bg-subtle/70 px-3 py-1.5 text-xs text-fg-3">
                    <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                    {t("tavern.generating")}
                  </div>
                )}
                <div ref={messageEndRef} />
              </div>
            )}
          </div>

          <div className="shrink-0 bg-surface px-5 pb-4 pt-3 lg:px-10">
            {selectedStory ? (
              <div className="mx-auto max-w-[840px] rounded-xl border border-border bg-app shadow-sm transition-shadow focus-within:border-border-strong focus-within:ring-[3px] focus-within:ring-action/10">
                <textarea
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={onComposerKeyDown}
                  placeholder={t("tavern.inputPlaceholder", {
                    name: storyCharacter?.name ?? "",
                  })}
                  aria-label={t("tavern.messageInput")}
                  disabled={sending || modelOptions.length === 0}
                  className="block max-h-[210px] min-h-[78px] w-full resize-y border-0 bg-transparent px-[15px] pb-2 pt-[14px] text-sm leading-6 text-fg-1 outline-none placeholder:text-fg-3 disabled:opacity-60"
                />
                <div className="flex flex-wrap items-center gap-2 px-2 pb-2">
                  {addCharacterMenu}
                  <select
                    id="tavern-model"
                    value={modelId}
                    onChange={(event) => setModelId(event.target.value)}
                    disabled={modelOptions.length === 0 || sending}
                    aria-label={t("tavern.model")}
                    className="h-8 max-w-[230px] min-w-0 rounded-lg border-0 bg-transparent px-2 text-xs text-fg-2 outline-none hover:bg-subtle disabled:opacity-60"
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
                  {catalog.isSuccess && modelOptions.length === 0 && (
                    <Button size="sm" variant="quiet" onClick={onOpenChannels}>
                      {t("tavern.configureModels")}
                    </Button>
                  )}
                  <span className="min-w-0 flex-1" />
                  <Button
                    size="sm"
                    disabled={!draft.trim() || sending || !modelId}
                    onClick={() => void send()}
                  >
                    {sending ? (
                      <LoaderCircle className="h-4 w-4 animate-spin" />
                    ) : (
                      <Send className="h-4 w-4" />
                    )}
                    {sending ? t("tavern.generating") : t("tavern.send")}
                  </Button>
                </div>
              </div>
            ) : (
              <p className="text-center text-xs text-fg-3">
                {catalog.isLoading
                  ? t("tavern.loadingModels")
                  : catalog.error
                    ? t("tavern.configureModelsHint")
                    : t("tavern.selectStoryHint")}
              </p>
            )}
          </div>
        </section>
      </div>
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
