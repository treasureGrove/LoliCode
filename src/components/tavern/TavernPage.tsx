import {
  useEffect,
  useCallback,
  useMemo,
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
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Clock3,
  LoaderCircle,
  MessageCircle,
  Plus,
  Send,
  Sparkles,
  Trash2,
  Upload,
} from "lucide-react";
import { AppPageHeader } from "@/components/shell/AppPageHeader";
import { Button } from "@/components/ui/button";
import { toast } from "@/lib/toast";
import {
  tavernApi,
  TAVERN_PRESETS_KEY,
  type TavernStory,
  type TavernSnapshot,
} from "@/lib/api/tavern";
import { TavernPresetGallery } from "./TavernPresetGallery";
import { TavernLocalModelPanel } from "./TavernLocalModelPanel";
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

export function TavernPage({ onOpenChannels }: { onOpenChannels: () => void }) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const refreshCatalog = useCallback(
    () => queryClient.invalidateQueries({ queryKey: CATALOG_QUERY_KEY }),
    [queryClient],
  );
  const [characterId, setCharacterId] = useState<string | null>(null);
  const [storyId, setStoryId] = useState<string | null>(null);
  const [modelId, setModelId] = useState("");
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [importing, setImporting] = useState(false);
  const [showContext, setShowContext] = useState(false);
  const [showPresets, setShowPresets] = useState(false);
  const messageEndRef = useRef<HTMLDivElement>(null);

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
  const selectedCharacter = characters.find((item) => item.id === characterId);
  const selectedStory = stories.find((item) => item.id === storyId);
  const selectedStoryCharacter = selectedStory
    ? characters.find((item) => item.id === selectedStory.characterId)
    : undefined;
  const visibleStories = useMemo(
    () => stories.filter((story) => story.characterId === characterId),
    [stories, characterId],
  );
  const avatar = useQuery({
    queryKey: ["tavern", "avatar", selectedCharacter?.id],
    queryFn: () => tavernApi.getAvatar(selectedCharacter!.id),
    enabled: Boolean(selectedCharacter?.hasAvatar),
    staleTime: Infinity,
    retry: false,
  });
  const context = useQuery({
    queryKey: ["tavern", "context", storyId],
    queryFn: () => tavernApi.previewContext(storyId!),
    enabled: showContext && Boolean(storyId),
    staleTime: 10_000,
  });

  useEffect(() => {
    if (!characterId && characters.length > 0) {
      setCharacterId(characters[0].id);
    } else if (
      characterId &&
      !characters.some((item) => item.id === characterId)
    ) {
      setCharacterId(characters[0]?.id ?? null);
      setStoryId(null);
    }
  }, [characters, characterId]);

  useEffect(() => {
    if (!storyId) return;
    const story = stories.find((item) => item.id === storyId);
    if (!story) setStoryId(null);
    else if (story.characterId !== characterId)
      setCharacterId(story.characterId);
  }, [stories, storyId, characterId]);

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
          { name: t("tavern.characterCard"), extensions: ["png", "json"] },
        ],
      });
      if (typeof path !== "string") return;
      const imported = await tavernApi.importCharacter(path);
      await queryClient.invalidateQueries({ queryKey: TAVERN_QUERY_KEY });
      setCharacterId(imported.id);
      setStoryId(null);
      toast.success(t("tavern.importSuccess", { name: imported.name }));
    } catch (error) {
      toast.error(t("tavern.importFailed"), { description: errorText(error) });
    } finally {
      setImporting(false);
    }
  };

  const createStory = async () => {
    if (!selectedCharacter) return;
    try {
      const story = await tavernApi.createStory(selectedCharacter.id);
      queryClient.setQueryData(
        TAVERN_QUERY_KEY,
        (current: typeof snapshot.data) =>
          current
            ? { ...current, stories: upsertStory(current.stories, story) }
            : current,
      );
      setStoryId(story.id);
      setShowContext(false);
    } catch (error) {
      toast.error(t("tavern.storyCreateFailed"), {
        description: errorText(error),
      });
    }
  };

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
    setCharacterId(character.id);
    setStoryId(story.id);
    setShowContext(false);
    setDraft("");
  };

  const deleteStory = async () => {
    if (!selectedStory || selectedStory.isGenerating) return;
    try {
      await tavernApi.deleteStory(selectedStory.id);
      await queryClient.invalidateQueries({ queryKey: TAVERN_QUERY_KEY });
      setStoryId(null);
      toast.success(t("tavern.storyDeleted"));
    } catch (error) {
      toast.error(t("tavern.storyDeleteFailed"), {
        description: errorText(error),
      });
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
      setDraft(text);
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
  const storyCharacter = selectedCharacter ?? selectedStoryCharacter;
  const avatarUrl =
    selectedCharacter?.id === "builtin:sillyloli"
      ? companion
      : avatar.data?.dataUrl;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <AppPageHeader
        icon={<BookHeart className="h-5 w-5" />}
        title={t("tavern.title")}
        subtitle={t("tavern.subtitle")}
        actions={
          <div className="flex items-center gap-2">
            <Button onClick={() => setShowPresets(true)}>
              <BookHeart className="h-4 w-4" />
              {t("tavern.presets.title")}
            </Button>
            <Button
              variant="outline"
              onClick={() => void importCharacter()}
              disabled={importing}
            >
              {importing ? (
                <LoaderCircle className="h-4 w-4 animate-spin" />
              ) : (
                <Upload className="h-4 w-4" />
              )}
              {t("tavern.importCard")}
            </Button>
          </div>
        }
      />

      <TavernLocalModelPanel onChange={refreshCatalog} />
      <div className="flex min-h-0 flex-1 gap-4 p-4 lg:p-5">
        <aside className="flex w-[280px] shrink-0 flex-col overflow-hidden rounded-2xl border border-border bg-surface/90 shadow-v7-sm max-lg:w-[230px] max-sm:hidden">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <div>
              <h2 className="text-sm font-semibold">
                {t("tavern.characterLibrary")}
              </h2>
              <p className="mt-0.5 text-xs text-fg-3">
                {t("tavern.characterCount", { count: characters.length })}
              </p>
            </div>
            <Button
              variant="quiet"
              size="icon-compact"
              aria-label={t("tavern.importCard")}
              title={t("tavern.importCard")}
              onClick={() => void importCharacter()}
              disabled={importing}
            >
              <Plus className="h-4 w-4" />
            </Button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {characters.length === 0 ? (
              <div className="px-3 py-6 text-center text-sm text-fg-3">
                <BookHeart className="mx-auto mb-2 h-6 w-6 opacity-65" />
                {t("tavern.noCharacters")}
              </div>
            ) : (
              <div className="space-y-1">
                {characters.map((character) => (
                  <button
                    key={character.id}
                    type="button"
                    onClick={() => {
                      setCharacterId(character.id);
                      setStoryId(null);
                    }}
                    className={cn(
                      "flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-subtle",
                      character.id === characterId &&
                        "bg-action/10 text-action-text",
                    )}
                  >
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-full border border-border bg-subtle text-fg-2">
                      {character.id === "builtin:sillyloli" ||
                      (character.hasAvatar &&
                        character.id === selectedCharacter?.id &&
                        avatarUrl) ? (
                        <img
                          src={
                            character.id === "builtin:sillyloli"
                              ? companion
                              : avatarUrl
                          }
                          alt=""
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <span className="font-serif text-lg">
                          {character.name.slice(0, 1)}
                        </span>
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">
                        {character.name}
                      </span>
                      <span className="block truncate text-xs text-fg-3">
                        {character.sourceFormat === "builtin"
                          ? t("tavern.presets.builtin")
                          : character.sourceFormat}
                      </span>
                    </span>
                    {character.id === characterId && (
                      <ChevronRight className="h-4 w-4 shrink-0 opacity-70" />
                    )}
                  </button>
                ))}
              </div>
            )}

            {selectedCharacter && (
              <div className="mt-5 border-t border-border pt-3">
                <div className="mb-2 flex items-center justify-between px-2">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-3">
                    {t("tavern.stories")}
                  </h3>
                  <Button
                    variant="quiet"
                    size="icon-compact"
                    aria-label={t("tavern.newStory")}
                    title={t("tavern.newStory")}
                    onClick={() => void createStory()}
                  >
                    <Plus className="h-4 w-4" />
                  </Button>
                </div>
                {visibleStories.length === 0 ? (
                  <p className="px-2 py-2 text-xs text-fg-3">
                    {t("tavern.noStories")}
                  </p>
                ) : (
                  <div className="space-y-1">
                    {visibleStories.map((story) => (
                      <button
                        key={story.id}
                        type="button"
                        onClick={() => setStoryId(story.id)}
                        className={cn(
                          "flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-subtle",
                          story.id === storyId && "bg-subtle font-medium",
                        )}
                      >
                        <MessageCircle className="h-3.5 w-3.5 shrink-0 text-fg-3" />
                        <span className="min-w-0 flex-1 truncate">
                          {story.title}
                        </span>
                        {story.isGenerating && (
                          <LoaderCircle className="h-3.5 w-3.5 animate-spin text-action-text" />
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
          <div className="border-t border-border px-4 py-3 text-[11px] leading-5 text-fg-3">
            {t("tavern.supportedFormats")}
          </div>
        </aside>

        <section className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border border-border bg-surface/90 shadow-v7-sm">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
            <div className="min-w-0">
              <h2 className="truncate text-base font-semibold">
                {selectedStory?.title ??
                  storyCharacter?.name ??
                  t("tavern.chooseCharacter")}
              </h2>
              {storyCharacter && (
                <p className="truncate text-xs text-fg-3">
                  {selectedStory
                    ? storyCharacter.name
                    : storyCharacter.sourceFormat === "builtin"
                      ? t("tavern.presets.builtin")
                      : storyCharacter.sourceFormat}
                  {storyCharacter.creator ? ` · ${storyCharacter.creator}` : ""}
                </p>
              )}
            </div>
            <div className="flex items-center gap-2">
              {selectedStory && (
                <>
                  <Button
                    variant={showContext ? "secondary" : "outline"}
                    size="sm"
                    onClick={() => setShowContext((value) => !value)}
                  >
                    <BookOpenText className="h-4 w-4" />
                    {t("tavern.contextPreview")}
                    {showContext ? (
                      <ChevronDown className="h-3.5 w-3.5" />
                    ) : (
                      <ChevronRight className="h-3.5 w-3.5" />
                    )}
                  </Button>
                  <Button
                    variant="quiet"
                    size="icon-compact"
                    aria-label={t("tavern.deleteStory")}
                    title={t("tavern.deleteStory")}
                    disabled={selectedStory.isGenerating}
                    onClick={() => void deleteStory()}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </>
              )}
              {selectedStory && (
                <label className="sr-only" htmlFor="tavern-model">
                  {t("tavern.model")}
                </label>
              )}
              <select
                id="tavern-model"
                value={modelId}
                onChange={(event) => setModelId(event.target.value)}
                disabled={modelOptions.length === 0 || sending}
                className="h-8 max-w-[250px] rounded-lg border border-border bg-surface px-2 text-xs text-fg-1 outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
                aria-label={t("tavern.model")}
                title={t("tavern.model")}
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
          </div>

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

          {showContext && selectedStory && (
            <div className="mx-4 mt-3 max-h-48 overflow-y-auto rounded-xl border border-border bg-subtle/60 p-3 text-xs">
              {context.isLoading ? (
                <div className="flex items-center gap-2 text-fg-3">
                  <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                  {t("tavern.loadingContext")}
                </div>
              ) : context.error ? (
                <p className="text-danger">{errorText(context.error)}</p>
              ) : context.data ? (
                <div className="space-y-2">
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-fg-3">
                    <span>
                      {t("tavern.worldInfoIncluded", {
                        count: context.data.includedEntries.length,
                        chars: context.data.worldInfoChars,
                      })}
                    </span>
                    <span>
                      {t("tavern.worldInfoExcluded", {
                        count: context.data.excludedEntries.length,
                      })}
                    </span>
                  </div>
                  {context.data.includedEntries.length > 0 && (
                    <p className="text-fg-2">
                      {t("tavern.includedEntries", {
                        entries: context.data.includedEntries.join("、"),
                      })}
                    </p>
                  )}
                  {context.data.excludedEntries.length > 0 && (
                    <p className="text-fg-3">
                      {t("tavern.excludedEntries", {
                        entries: context.data.excludedEntries.join("、"),
                      })}
                    </p>
                  )}
                  <details>
                    <summary className="cursor-pointer select-none font-medium text-action-text">
                      {t("tavern.promptDetails")}
                    </summary>
                    <pre className="mt-2 whitespace-pre-wrap break-words font-sans leading-5 text-fg-2">
                      {context.data.preHistory}
                      {context.data.postHistory
                        ? `\n\n${context.data.postHistory}`
                        : ""}
                    </pre>
                  </details>
                </div>
              ) : null}
            </div>
          )}

          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 lg:px-8">
            {!selectedStory ? (
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
                  <Button className="mt-5" onClick={() => void createStory()}>
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
                      {message.role === "assistant" &&
                      selectedStoryCharacter?.id === selectedCharacter?.id &&
                      avatarUrl ? (
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

          <div className="border-t border-border bg-surface/80 p-3 lg:p-4">
            {selectedStory ? (
              <div className="mx-auto max-w-3xl rounded-2xl border border-border bg-app shadow-v7-sm focus-within:border-border-strong">
                <textarea
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={onComposerKeyDown}
                  placeholder={t("tavern.inputPlaceholder", {
                    name: storyCharacter?.name ?? "",
                  })}
                  aria-label={t("tavern.messageInput")}
                  disabled={sending || modelOptions.length === 0}
                  className="block max-h-48 min-h-[76px] w-full resize-y bg-transparent px-4 py-3 text-sm leading-6 text-fg-1 outline-none placeholder:text-fg-3 disabled:opacity-60"
                />
                <div className="flex items-center justify-between gap-3 px-3 pb-2.5">
                  <p className="min-w-0 truncate text-[11px] text-fg-3">
                    {selectedStory.messages.length > 0
                      ? t("tavern.messageCount", {
                          count: selectedStory.messages.length,
                        })
                      : t("tavern.contextUsesSharedModel")}
                  </p>
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
            <p className="mt-2 text-center text-[10px] text-fg-3">
              {t("tavern.enterHint")}
            </p>
          </div>
        </section>
      </div>
      <TavernPresetGallery
        open={showPresets}
        onOpenChange={setShowPresets}
        onStart={startPreset}
        busy={sending || Boolean(selectedStory?.isGenerating)}
      />
    </div>
  );
}
