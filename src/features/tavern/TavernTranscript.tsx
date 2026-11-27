import {
  memo,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ArrowUpRight,
  BookHeart,
  Brain,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Compass,
  Copy,
  FileText,
  Globe,
  Image as ImageIcon,
  LoaderCircle,
  MessageSquare,
  Pencil,
  RotateCcw,
  Sparkles,
  Volume2,
  VolumeX,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Markdown } from "@/features/chat-demo/components/markdown/Markdown";
import { LOLICODE_ACCOUNT_QUERY_KEY } from "@/hooks/useLolicodeAccount";
import type { LolicodeAccountStatus } from "@/lib/api/lolicode-account";
import type { TavernMessage } from "@/lib/api/tavern";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import {
  parseTavernRichMessage,
  toggleTavernReadAloud,
  useTavernBranches,
  useTavernReadAloudStatus,
} from "./tavernChatCoupling";

const PAGE_SIZE = 64;

const TavernMessageBubbleActions = memo(function TavernMessageBubbleActions({
  storyId,
  messageId,
  isUser,
  activeText,
  cleanContent,
  versions,
  activeVersionIndex,
  sending,
  onSelectVersion,
  onStartEdit,
  onRegenerate,
}: {
  storyId?: string;
  messageId: string;
  isUser: boolean;
  activeText: string;
  cleanContent: string;
  versions: string[];
  activeVersionIndex: number;
  sending: boolean;
  onSelectVersion: (nextIndex: number) => void;
  onStartEdit?: () => void;
  onRegenerate?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const readStatus = useTavernReadAloudStatus(messageId);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(cleanContent);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      toast.error("复制失败");
    }
  };

  return (
    <div
      className={cn(
        "tavern-bubble-actions mt-2 flex flex-wrap items-center gap-1 pt-1.5 text-[11px]",
        isUser && "justify-end",
      )}
    >
      {versions.length > 1 && storyId && (
        <div className="tavern-branch-pill mr-1 inline-flex items-center gap-0.5 rounded-md px-1 py-0.5 text-[11px] font-medium">
          <button
            type="button"
            aria-label="上一版本"
            title="上一分支版本"
            disabled={activeVersionIndex <= 0 || sending}
            onClick={() => onSelectVersion(activeVersionIndex - 1)}
            className="inline-flex h-4 w-4 items-center justify-center rounded disabled:opacity-40"
          >
            <ChevronLeft className="h-3 w-3" />
          </button>
          <span className="px-0.5 tabular-nums">
            {activeVersionIndex + 1}/{versions.length}
          </span>
          <button
            type="button"
            aria-label="下一版本"
            title="下一分支版本"
            disabled={activeVersionIndex >= versions.length - 1 || sending}
            onClick={() => onSelectVersion(activeVersionIndex + 1)}
            className="inline-flex h-4 w-4 items-center justify-center rounded disabled:opacity-40"
          >
            <ChevronRight className="h-3 w-3" />
          </button>
        </div>
      )}

      <button
        type="button"
        aria-label="复制消息"
        title="复制内容"
        onClick={() => void handleCopy()}
        className="tavern-bubble-action-btn"
      >
        {copied ? (
          <Check className="h-3 w-3 text-emerald-500" />
        ) : (
          <Copy className="h-3 w-3" />
        )}
        <span>{copied ? "已复制" : "复制"}</span>
      </button>

      {!isUser && cleanContent.trim() && (
        <button
          type="button"
          aria-label={readStatus === "idle" ? "朗读消息" : "停止朗读"}
          title={readStatus === "idle" ? "语音朗读" : "停止朗读"}
          onClick={() =>
            toggleTavernReadAloud(messageId, activeText, (msg) =>
              toast.error(msg),
            )
          }
          className={cn(
            "tavern-bubble-action-btn",
            readStatus !== "idle" && "is-active",
          )}
        >
          {readStatus === "loading" ? (
            <LoaderCircle className="h-3 w-3 animate-spin" />
          ) : readStatus === "playing" ? (
            <VolumeX className="h-3 w-3" />
          ) : (
            <Volume2 className="h-3 w-3" />
          )}
          <span>{readStatus === "idle" ? "朗读" : "停止"}</span>
        </button>
      )}

      {!isUser && onRegenerate && (
        <button
          type="button"
          aria-label="重新生成回复"
          title="重新生成角色回应（保留分支版本）"
          disabled={sending}
          onClick={onRegenerate}
          className="tavern-bubble-action-btn"
        >
          <RotateCcw className="h-3 w-3" />
          <span>重新生成</span>
        </button>
      )}

      {isUser && onStartEdit && (
        <button
          type="button"
          aria-label="编辑这条消息"
          title="修改并重新发送"
          disabled={sending}
          onClick={onStartEdit}
          className="tavern-bubble-action-btn"
        >
          <Pencil className="h-3 w-3" />
          <span>编辑</span>
        </button>
      )}
    </div>
  );
});

export const TavernTranscript = memo(function TavernTranscript({
  active,
  storyId,
  avatarUrl,
  characterName,
  alternateGreetings,
  messages,
  sending,
  headerSlot,
  onQuickPrompt,
  onRegenerateMessage,
  onEditUserMessage,
}: {
  active: boolean;
  storyId?: string;
  avatarUrl?: string;
  characterName?: string;
  alternateGreetings?: string[];
  messages: TavernMessage[];
  sending: boolean;
  headerSlot?: ReactNode;
  onQuickPrompt?: (prompt: string) => void;
  onRegenerateMessage?: (
    assistantMessage: TavernMessage,
    precedingUserText: string,
  ) => void;
  onEditUserMessage?: (
    userMessage: TavernMessage,
    nextText: string,
    followingAssistantMessage?: TavernMessage,
  ) => void;
}) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const account = queryClient.getQueryData<LolicodeAccountStatus>(
    LOLICODE_ACCOUNT_QUERY_KEY,
  )?.account;
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const timeFormat = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }),
    [locale],
  );
  const [start, setStart] = useState(() =>
    Math.max(0, messages.length - PAGE_SIZE),
  );
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editingDraft, setEditingDraft] = useState("");
  const branchVersions = useTavernBranches((state) => state.versions);
  const branchActiveIndex = useTavernBranches((state) => state.activeIndex);
  const selectBranchVersion = useTavernBranches((state) => state.selectVersion);

  const first = Math.min(start, Math.max(0, messages.length - 1));
  const tail = messages.at(-1)?.id;
  const scrollRef = useRef<HTMLDivElement>(null);
  const followTail = useRef(true);
  const previous = useRef<{ tail: string | undefined; sending: boolean }>();
  const prepend = useRef<{ height: number; top: number }>();

  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    if (!active || !scroll) return;
    if (sending && !previous.current?.sending) followTail.current = true;
    if (prepend.current) {
      scroll.scrollTop =
        prepend.current.top + scroll.scrollHeight - prepend.current.height;
      prepend.current = undefined;
    } else if (
      followTail.current &&
      (previous.current?.tail !== tail || previous.current?.sending !== sending)
    ) {
      scroll.scrollTop = scroll.scrollHeight;
    }
    previous.current = { tail, sending };
  }, [active, first, sending, tail]);

  const loadEarlier = () => {
    const scroll = scrollRef.current;
    if (!scroll || !first) return;
    followTail.current = false;
    prepend.current = { height: scroll.scrollHeight, top: scroll.scrollTop };
    setStart(Math.max(0, first - PAGE_SIZE));
  };

  const rows = useMemo(
    () =>
      messages.slice(first).map((message, sliceIdx) => {
        const absoluteIdx = first + sliceIdx;
        const user = message.role === "user";
        const date = new Date(message.createdAt);
        const time = Number.isNaN(date.getTime())
          ? date.toString()
          : timeFormat.format(date);

        const branchKey = storyId ? `${storyId}:${message.id}` : message.id;
        const storedVersions = branchVersions[branchKey];
        const isOpeningGreeting =
          absoluteIdx === 0 &&
          !user &&
          Boolean(alternateGreetings && alternateGreetings.length > 0);
        const versions =
          storedVersions && storedVersions.length > 0
            ? storedVersions
            : isOpeningGreeting
              ? [
                  message.text,
                  ...(alternateGreetings ?? []).filter(
                    (item) => item.trim() && item !== message.text,
                  ),
                ]
              : [message.text];
        const activeVersionIdx = Math.min(
          versions.length - 1,
          Math.max(
            0,
            branchActiveIndex[branchKey] ??
              (storedVersions ? versions.length - 1 : 0),
          ),
        );
        const activeRawText =
          versions.length > 1
            ? (versions[activeVersionIdx] ?? message.text)
            : message.text;

        const parsed = parseTavernRichMessage(activeRawText);

        let precedingUserText = "";
        if (!user) {
          for (let i = absoluteIdx - 1; i >= 0; i -= 1) {
            if (messages[i]?.role === "user") {
              precedingUserText = messages[i].text;
              break;
            }
          }
        }
        const followingAssistantMessage =
          user && messages[absoluteIdx + 1]?.role === "assistant"
            ? messages[absoluteIdx + 1]
            : undefined;

        const isEditing = editingMessageId === message.id;
        const userDisplayName = account?.displayName || t("tavern.you");

        return (
          <article
            key={message.id}
            className={cn(
              "wb-chat-message group/bubble",
              user && "wb-chat-message--user",
            )}
          >
            <span className="wb-chat-avatar" aria-hidden="true">
              {user ? (
                account?.avatarUrl ? (
                  <img
                    src={account.avatarUrl}
                    alt=""
                    decoding="async"
                    referrerPolicy="no-referrer"
                  />
                ) : (
                  <span className="wb-chat-avatar-fallback">
                    {t("tavern.youShort")}
                  </span>
                )
              ) : avatarUrl ? (
                <img src={avatarUrl} alt="" decoding="async" />
              ) : (
                <span className="wb-chat-avatar-fallback">
                  <BookHeart className="h-4 w-4" />
                </span>
              )}
            </span>

            <div className="wb-chat-message-body">
              <div
                className={cn(
                  "wb-chat-author flex items-center gap-2",
                  user && "justify-end",
                )}
              >
                <span className="font-medium text-fg-2">
                  {user ? userDisplayName : characterName}
                </span>
                <span className="inline-flex items-center gap-1 opacity-75">
                  <Clock3 className="h-3 w-3" />
                  <time>{time}</time>
                </span>
                {message.failed && (
                  <span className="font-medium text-danger">
                    {t("tavern.generationFailedShort")}
                  </span>
                )}
              </div>

              <div
                className={cn(
                  "wb-chat-bubble",
                  user ? "wb-message-user" : "wb-message-assistant",
                  message.failed && "border-danger/45",
                )}
                data-companion-surface={
                  !user && storyId
                    ? `tavern-${storyId}-${message.id}`
                    : undefined
                }
                data-companion-dock-id={
                  !user && storyId
                    ? `tavern-${storyId}-${message.id}`
                    : undefined
                }
                data-companion-rest={!user && storyId ? "sit" : undefined}
              >
                {parsed.attachments.length > 0 && (
                  <div className="mb-2 flex flex-wrap gap-1.5">
                    {parsed.attachments.map((att, idx) => (
                      <div
                        key={`${att.name}-${idx}`}
                        className="wb-message-document"
                      >
                        {att.kind === "image" ? (
                          <ImageIcon className="h-3.5 w-3.5 text-action-text" />
                        ) : (
                          <FileText className="h-3.5 w-3.5 text-action-text" />
                        )}
                        <span className="max-w-[180px] truncate">
                          {att.name}
                        </span>
                      </div>
                    ))}
                  </div>
                )}

                {parsed.thinking && (
                  <details
                    open={!parsed.thinkingComplete}
                    className="tavern-thinking-disclosure mb-2.5"
                  >
                    <summary className="flex cursor-pointer select-none items-center gap-1.5 font-medium">
                      <Brain className="h-3.5 w-3.5 text-action-text" />
                      <span>
                        {parsed.thinkingComplete
                          ? "深度思考 · 角色内心推演"
                          : "正在思考..."}
                      </span>
                    </summary>
                    <div className="mt-2 whitespace-pre-wrap break-words border-t border-border/50 pt-2 leading-6 text-fg-3">
                      {parsed.thinking}
                    </div>
                  </details>
                )}

                {isEditing ? (
                  <div className="mt-1 space-y-2">
                    <textarea
                      value={editingDraft}
                      onChange={(event) => setEditingDraft(event.target.value)}
                      aria-label="编辑消息内容"
                      rows={3}
                      className="w-full rounded-xl border border-border bg-surface px-3 py-2 text-sm text-fg-1 outline-none focus:border-action"
                    />
                    <div className="flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => setEditingMessageId(null)}
                        className="rounded-lg px-2.5 py-1 text-xs text-fg-2 hover:bg-subtle"
                      >
                        取消编辑
                      </button>
                      <button
                        type="button"
                        disabled={!editingDraft.trim() || sending}
                        onClick={() => {
                          const next = editingDraft.trim();
                          setEditingMessageId(null);
                          if (next && onEditUserMessage) {
                            onEditUserMessage(
                              message,
                              next,
                              followingAssistantMessage,
                            );
                          }
                        }}
                        className="rounded-lg bg-action px-2.5 py-1 text-xs font-medium text-action-fg hover:bg-action-hover disabled:opacity-50"
                      >
                        保存并重发
                      </button>
                    </div>
                  </div>
                ) : parsed.isRichMarkdown ? (
                  <div className="tavern-rich-markdown text-body">
                    <Markdown
                      content={parsed.content}
                      loading={false}
                      cacheKey={`${message.id}:${activeVersionIdx}`}
                      disableLink={false}
                      sources={
                        parsed.sources.length > 0 ? parsed.sources : undefined
                      }
                    />
                  </div>
                ) : (
                  <p className="whitespace-pre-wrap break-words text-body">
                    {parsed.content}
                  </p>
                )}

                {parsed.sources.length > 0 && (
                  <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-border/40 pt-2">
                    <span className="inline-flex items-center gap-1 text-[11px] text-fg-3">
                      <Globe className="h-3 w-3" />
                      参考来源：
                    </span>
                    {parsed.sources.map((source) => (
                      <a
                        key={`${source.index}-${source.url}`}
                        href={source.url}
                        target="_blank"
                        rel="noreferrer"
                        className="tavern-source-pill inline-flex max-w-[200px] items-center gap-1 truncate rounded-md px-2 py-0.5 text-[11px]"
                      >
                        <span>[{source.index}]</span>
                        <span className="truncate">{source.title}</span>
                      </a>
                    ))}
                  </div>
                )}

                {storyId && !isEditing && (
                  <TavernMessageBubbleActions
                    storyId={storyId}
                    messageId={message.id}
                    isUser={user}
                    activeText={activeRawText}
                    cleanContent={parsed.content}
                    versions={versions}
                    activeVersionIndex={activeVersionIdx}
                    sending={sending}
                    onSelectVersion={(nextIdx) =>
                      selectBranchVersion(branchKey, nextIdx)
                    }
                    onRegenerate={
                      !user && precedingUserText && onRegenerateMessage
                        ? () => onRegenerateMessage(message, precedingUserText)
                        : undefined
                    }
                    onStartEdit={
                      user && onEditUserMessage
                        ? () => {
                            setEditingDraft(parsed.content);
                            setEditingMessageId(message.id);
                          }
                        : undefined
                    }
                  />
                )}
              </div>
            </div>
          </article>
        );
      }),
    [
      account?.avatarUrl,
      account?.displayName,
      alternateGreetings,
      avatarUrl,
      branchActiveIndex,
      branchVersions,
      characterName,
      editingDraft,
      editingMessageId,
      first,
      messages,
      onEditUserMessage,
      onRegenerateMessage,
      selectBranchVersion,
      sending,
      storyId,
      t,
      timeFormat,
    ],
  );

  const showStarterHints =
    Boolean(onQuickPrompt) && messages.length === 1 && !sending;

  return (
    <div
      ref={scrollRef}
      className="wb-chat"
      style={{ overflowAnchor: "none" }}
      onScroll={({ currentTarget }) => {
        followTail.current =
          currentTarget.scrollHeight -
            currentTarget.clientHeight -
            currentTarget.scrollTop <=
          24;
      }}
    >
      <div className="wb-chat-content">
        {first > 0 && (
          <Button
            type="button"
            variant="ghost"
            className="wb-history-earlier self-center"
            onClick={loadEarlier}
          >
            {t("tavern.loadEarlier")}
          </Button>
        )}
        {first === 0 && headerSlot}
        {rows}
        {showStarterHints && onQuickPrompt && (
          <div className="tavern-starter-block">
            <div className="tavern-starter-label">
              <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
              <span>开场灵感 · 选一句直接开启故事</span>
            </div>
            <div className="wb-task-starters">
              {[
                {
                  icon: MessageSquare,
                  title: "日常寒暄",
                  detail: "自然接话，了解此刻正在忙碌什么",
                  prompt: "刚才在忙什么呀？今天过得怎么样？",
                },
                {
                  icon: Compass,
                  title: "探索当前场景",
                  detail: "顺着眼前氛围展开剧情与小细节",
                  prompt: "四下看了看周围的环境，你现在打算接着做什么？",
                },
                {
                  icon: Brain,
                  title: "深聊设定与想法",
                  detail: "围绕角色心境与故事主线深入交流",
                  prompt: "能跟我说说你现在心里真正在想的事吗？",
                },
              ].map(({ icon: Icon, title, detail, prompt }) => (
                <button
                  key={title}
                  type="button"
                  className="wb-task-starter"
                  onClick={() => onQuickPrompt(prompt)}
                >
                  <span className="wb-task-starter-icon">
                    <Icon aria-hidden="true" />
                  </span>
                  <strong>{title}</strong>
                  <span>{detail}</span>
                  <ArrowUpRight
                    className="wb-task-starter-arrow"
                    aria-hidden="true"
                  />
                </button>
              ))}
            </div>
          </div>
        )}
        {sending && (
          <div className="wb-chat-message" aria-hidden="true">
            <span className="wb-chat-avatar">
              {avatarUrl ? (
                <img src={avatarUrl} alt="" decoding="async" />
              ) : (
                <span className="wb-chat-avatar-fallback">
                  <BookHeart className="h-4 w-4" />
                </span>
              )}
            </span>
            <div className="wb-chat-message-body">
              <div className="wb-chat-bubble wb-message-assistant inline-flex min-h-9 items-center">
                <span className="tavern-typing-dots">
                  <span />
                  <span />
                  <span />
                </span>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
});
