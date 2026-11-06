import { memo, useContext, useState, type ReactNode } from "react";
import { Sparkles, UserRound } from "lucide-react";
import { ViewPreparationContext } from "@/components/ViewActivityContext";
import assistantPortrait from "@/assets/brand/lolicode-icon.png";
import { BUILTIN_AGENT_NICKNAME } from "@/lib/branding";
import { cn } from "@/lib/utils";
import type { AgentMessage } from "@/types/agent";

export interface AgentMessageIdentity {
  displayName?: string;
  avatarUrl?: string;
}

function MessageAvatar({
  role,
  identity,
}: {
  role: "user" | "assistant";
  identity?: AgentMessageIdentity;
}) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const source = role === "assistant" ? assistantPortrait : identity?.avatarUrl;
  const initial = Array.from(identity?.displayName?.trim() || "")[0];
  return (
    <span className="wb-chat-avatar" aria-hidden="true">
      {source && source !== failedUrl ? (
        <img
          src={source}
          alt=""
          draggable={false}
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setFailedUrl(source)}
        />
      ) : (
        <span className="wb-chat-avatar-fallback">
          {role === "assistant" ? (
            <Sparkles />
          ) : initial ? (
            initial.toLocaleUpperCase()
          ) : (
            <UserRound />
          )}
        </span>
      )}
    </span>
  );
}

/** The frame owns identity and alignment; transcript blocks retain their order. */
export const AgentMessageFrame = memo(function AgentMessageFrame({
  role,
  identity,
  ariaLabel,
  showAuthor = true,
  className,
  companionSurface,
  children,
}: {
  role: AgentMessage["role"];
  identity?: AgentMessageIdentity;
  ariaLabel?: string;
  showAuthor?: boolean;
  className?: string;
  companionSurface?: { id: string; text: string };
  children: ReactNode;
}) {
  const preparing = useContext(ViewPreparationContext);
  // Code and execution surfaces stay clear; the companion checks the remaining
  // bubble's visible width and headroom before offering its top edge.
  const companionSurfaceId =
    !preparing &&
    role !== "system" &&
    companionSurface?.text.trim() &&
    !/`|^\s*~{3,}|^(?: {4}|\t)\S/m.test(companionSurface.text)
      ? companionSurface.id
      : undefined;
  const author =
    role === "user"
      ? identity?.displayName?.trim() || "你"
      : role === "assistant"
        ? BUILTIN_AGENT_NICKNAME
        : "系统";
  return (
    <article
      aria-label={
        ariaLabel ||
        (role === "user"
          ? "你的消息"
          : role === "assistant"
            ? "Agent 回复"
            : "系统消息")
      }
      className={cn("wb-chat-message", `wb-chat-message--${role}`, className)}
    >
      {role !== "system" && <MessageAvatar role={role} identity={identity} />}
      <div className="wb-chat-message-body">
        {showAuthor && (
          <p className={cn("wb-chat-author", role === "user" && "sr-only")}>
            {author}
          </p>
        )}
        <div
          className={cn("wb-chat-bubble", `wb-message-${role}`)}
          data-companion-surface={companionSurfaceId}
          data-companion-dock-id={companionSurfaceId}
          data-companion-rest={companionSurfaceId ? "sit" : undefined}
        >
          {children}
        </div>
      </div>
    </article>
  );
});
