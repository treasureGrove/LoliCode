import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowUpRight, LoaderCircle, MessageSquare, Send } from "lucide-react";
import { agentErrorMessage } from "@/hooks/useAgentSnapshot";
import { agentApi } from "@/lib/api/agent";
import { settingsApi } from "@/lib/api/settings";
import type { AgentSecretaryGithubReplyReceipt } from "@/types/agent";
import { bounded, safeGithubUrl } from "./secretaryRequests";

const MAX_REPLY_BYTES = 16_000;

export function AgentSecretaryGithubReply({
  sessionId,
  itemId,
  summary,
  login,
}: {
  sessionId: string;
  itemId: string;
  summary: string;
  login: string | null;
}) {
  const { t } = useTranslation();
  const label = (
    key: string,
    defaultValue: string,
    values?: Record<string, unknown>,
  ) => t(`agentSecretary.github.${key}`, { defaultValue, ...values });
  const [expanded, setExpanded] = useState(false);
  const [receipt, setReceipt] =
    useState<AgentSecretaryGithubReplyReceipt | null>();
  const [draft, setDraft] = useState<string>();
  const [attempted, setAttempted] = useState<string>();
  const [readError, setReadError] = useState("");
  const [actionError, setActionError] = useState("");
  const [sending, setSending] = useState(false);
  const [revision, setRevision] = useState(0);
  const pending = useRef(false);
  const readVersion = useRef(0);
  const mounted = useRef(false);
  const bodyInput = useRef<HTMLTextAreaElement>(null);
  const panelId = useId();

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!expanded) return;
    let disposed = false;
    const version = readVersion.current;
    setReadError("");
    void bounded(
      agentApi.getSecretaryGithubReply(sessionId, itemId),
      label("replyTimeout", "读取或发送回报超时。请重试查看回执。"),
    ).then(
      (next) => {
        if (!disposed && readVersion.current === version) setReceipt(next);
      },
      (error) => {
        if (!disposed && readVersion.current === version)
          setReadError(agentErrorMessage(error));
      },
    );
    return () => {
      disposed = true;
    };
  }, [expanded, revision, sessionId, itemId]);

  const loaded = receipt !== undefined;
  useEffect(() => {
    if (expanded && loaded) bodyInput.current?.focus();
  }, [expanded, loaded]);

  const locked = receipt?.status === "pending" || attempted !== undefined;
  const body = receipt?.body ?? attempted ?? draft ?? summary;
  const tooLong =
    new TextEncoder().encode(body.trim()).length > MAX_REPLY_BYTES;
  const href = receipt?.url && safeGithubUrl(receipt.url);
  const send = async () => {
    if (
      pending.current ||
      !body.trim() ||
      tooLong ||
      receipt === undefined ||
      receipt?.status === "sent"
    )
      return;
    pending.current = true;
    readVersion.current += 1;
    const outbound = locked ? body : body.trim();
    setAttempted(outbound);
    setSending(true);
    setActionError("");
    try {
      const next = await bounded(
        agentApi.sendSecretaryGithubReply(sessionId, itemId, outbound),
        label("replyTimeout", "读取或发送回报超时。请重试查看回执。"),
      );
      if (mounted.current) setReceipt(next);
    } catch (error) {
      if (mounted.current) setActionError(agentErrorMessage(error));
    } finally {
      pending.current = false;
      if (mounted.current) setSending(false);
    }
  };

  return (
    <div className="wb-secretary-github-reply">
      <button
        type="button"
        className="wb-secretary-task-open"
        aria-expanded={expanded}
        aria-controls={panelId}
        disabled={sending}
        onClick={() => setExpanded((value) => !value)}
      >
        <MessageSquare aria-hidden="true" />
        {receipt?.status === "sent"
          ? label("replySent", "已回报到 GitHub")
          : label("prepareReply", "准备回报")}
      </button>
      {expanded && (
        <div id={panelId}>
          {(readError || actionError || receipt?.error) && (
            <div className="wb-secretary-error" role="alert">
              <span>{readError || actionError || receipt?.error}</span>
              {readError && (
                <button
                  type="button"
                  onClick={() => setRevision((value) => value + 1)}
                >
                  {label("retry", "重试")}
                </button>
              )}
            </div>
          )}
          {receipt === undefined && !readError && (
            <p className="wb-secretary-github-loading" role="status">
              <LoaderCircle className="animate-spin" aria-hidden="true" />
              {label("replyLoading", "正在读取回报状态…")}
            </p>
          )}
          {receipt?.status === "sent" && (
            <div className="wb-secretary-github-sent">
              <p>{receipt.body}</p>
              {href && (
                <button
                  type="button"
                  className="wb-secretary-task-open"
                  onClick={() => {
                    void settingsApi.openExternal(href).catch((error) => {
                      if (mounted.current)
                        setActionError(agentErrorMessage(error));
                    });
                  }}
                >
                  <ArrowUpRight aria-hidden="true" />
                  {label("openReply", "在 GitHub 查看回报")}
                </button>
              )}
            </div>
          )}
          {receipt !== undefined && receipt?.status !== "sent" && (
            <form
              className="wb-secretary-form"
              onSubmit={(event) => {
                event.preventDefault();
                void send();
              }}
            >
              <p className="wb-secretary-note">
                {login
                  ? label(
                      "replyAccount",
                      "将以 @{{login}} 向该 GitHub 讨论发送回报。",
                      { login },
                    )
                  : label(
                      "replyDestination",
                      "将使用已连接的账号向该 GitHub 讨论发送回报。",
                    )}
              </p>
              <label>
                {label("replyBody", "回报正文")}
                <textarea
                  ref={bodyInput}
                  value={body}
                  rows={3}
                  maxLength={MAX_REPLY_BYTES}
                  readOnly={locked || sending}
                  onChange={(event) => setDraft(event.target.value)}
                  required
                />
              </label>
              {locked && (
                <p className="wb-secretary-note">
                  {label(
                    "replyPending",
                    "回报尚未确认。重试会继续发送同一条回报。",
                  )}
                </p>
              )}
              {tooLong && (
                <p className="wb-secretary-task-error" role="alert">
                  {label("replyTooLong", "回报正文最多 16,000 字节。")}
                </p>
              )}
              <div className="wb-secretary-form-actions">
                <button
                  type="submit"
                  disabled={
                    sending || Boolean(readError) || tooLong || !body.trim()
                  }
                >
                  {sending ? (
                    <LoaderCircle className="animate-spin" aria-hidden="true" />
                  ) : (
                    <Send aria-hidden="true" />
                  )}
                  {locked
                    ? label("retryReply", "重试发送")
                    : label("sendReply", "发送到 GitHub")}
                </button>
              </div>
            </form>
          )}
        </div>
      )}
    </div>
  );
}
