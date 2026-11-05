import { memo, useLayoutEffect, useMemo, useRef, useState } from "react";
import { BookHeart, Clock3, LoaderCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import type { TavernMessage } from "@/lib/api/tavern";
import { cn } from "@/lib/utils";

const PAGE_SIZE = 64;

export const TavernTranscript = memo(function TavernTranscript({
  active,
  avatarUrl,
  characterName,
  messages,
  sending,
}: {
  active: boolean;
  avatarUrl?: string;
  characterName?: string;
  messages: TavernMessage[];
  sending: boolean;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const timeFormat = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }),
    [locale],
  );
  const [start, setStart] = useState(() =>
    Math.max(0, messages.length - PAGE_SIZE),
  );
  const first = Math.min(start, messages.length - 1);
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
      messages.slice(first).map((message) => {
        const user = message.role === "user";
        const date = new Date(message.createdAt);
        const time = Number.isNaN(date.getTime())
          ? date.toString()
          : timeFormat.format(date);
        return (
          <article
            key={message.id}
            className={cn("flex gap-3", user && "flex-row-reverse")}
          >
            <div
              className={cn(
                "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full border border-border bg-subtle text-xs font-medium text-fg-2",
                user && "bg-action/10 text-action-text",
              )}
            >
              {user ? (
                t("tavern.youShort")
              ) : avatarUrl ? (
                <img
                  src={avatarUrl}
                  alt=""
                  decoding="async"
                  className="h-full w-full object-cover"
                />
              ) : (
                <BookHeart className="h-4 w-4" />
              )}
            </div>
            <div
              className={cn(
                "min-w-0 max-w-[min(82%,680px)] rounded-2xl border border-border bg-subtle/65 px-4 py-3",
                user && "bg-action/10",
                message.failed && "border-danger/40",
              )}
            >
              <div className="mb-1 flex items-center gap-2 text-[11px] text-fg-3">
                <span className="font-medium text-fg-2">
                  {user ? t("tavern.you") : characterName}
                </span>
                <Clock3 className="h-3 w-3" />
                <time>{time}</time>
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
        );
      }),
    [avatarUrl, characterName, first, messages, t, timeFormat],
  );

  return (
    <div
      ref={scrollRef}
      className="min-h-0 flex-1 overflow-y-auto px-4 py-5 lg:px-8"
      style={{ overflowAnchor: "none" }}
      onScroll={({ currentTarget }) => {
        followTail.current =
          currentTarget.scrollHeight -
            currentTarget.clientHeight -
            currentTarget.scrollTop <=
          24;
      }}
    >
      <div className="mx-auto flex max-w-3xl flex-col gap-5">
        {first > 0 && (
          <Button
            type="button"
            variant="ghost"
            className="self-center"
            onClick={loadEarlier}
          >
            {t("tavern.loadEarlier")}
          </Button>
        )}
        {rows}
        {sending && (
          <div className="flex items-center gap-2 self-start rounded-full border border-border bg-subtle/70 px-3 py-1.5 text-xs text-fg-3">
            <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
            {t("tavern.generating")}
          </div>
        )}
      </div>
    </div>
  );
});
