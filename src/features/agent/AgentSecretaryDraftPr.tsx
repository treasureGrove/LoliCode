import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ArrowUpRight,
  GitPullRequestDraft,
  LoaderCircle,
  RefreshCw,
} from "lucide-react";
import { agentErrorMessage } from "@/hooks/useAgentSnapshot";
import { agentApi } from "@/lib/api/agent";
import { settingsApi } from "@/lib/api/settings";
import type { AgentSecretaryDraftPr } from "@/types/agent";
import { bounded, safeGithubUrl } from "./secretaryRequests";

const lifecycleLabels = {
  draft: "草稿",
  open: "开放",
  merged: "已合并",
  closed: "已关闭",
};

export function AgentSecretaryDraftPrCard({
  sessionId,
  taskId,
  disabled = false,
}: {
  sessionId: string;
  taskId: string;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const label = (
    key: string,
    defaultValue: string,
    values?: Record<string, unknown>,
  ) => t(`agentSecretary.github.draftPr.${key}`, { defaultValue, ...values });
  const [expanded, setExpanded] = useState(false);
  const [preview, setPreview] = useState<AgentSecretaryDraftPr>();
  const [edits, setEdits] = useState<
    Partial<Pick<AgentSecretaryDraftPr, "title" | "body">>
  >({});
  const [action, setAction] = useState<"read" | "publish" | null>(null);
  const [error, setError] = useState("");
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const pending = useRef(false);
  const mounted = useRef(false);
  const panelId = useId();

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = async (kind: "read" | "publish", update: () => Promise<void>) => {
    if (pending.current || disabled) return;
    pending.current = true;
    setAction(kind);
    setError("");
    try {
      await update();
    } catch (cause) {
      if (mounted.current) {
        setError(agentErrorMessage(cause));
        setNeedsRefresh(true);
      }
    } finally {
      pending.current = false;
      if (mounted.current) setAction(null);
    }
  };

  const read = () =>
    void run("read", async () => {
      const next = await bounded(
        agentApi.getSecretaryDraftPr(sessionId, taskId),
        label("readTimeout", "读取 PR 草稿预览超时，请重试。"),
        75_000,
      );
      if (mounted.current) {
        setPreview(next);
        setNeedsRefresh(false);
      }
    });
  const title = preview?.receipt?.title ?? edits.title ?? preview?.title ?? "";
  const body = preview?.receipt?.body ?? edits.body ?? preview?.body ?? "";
  const tooLong = new TextEncoder().encode(body.trim()).length > 16_000;
  const publish = () => {
    if (
      !preview ||
      needsRefresh ||
      preview.receipt?.status === "published" ||
      !title.trim() ||
      tooLong
    )
      return;
    void run("publish", async () => {
      const receipt = await bounded(
        agentApi.publishSecretaryDraftPr(sessionId, taskId, {
          headRevision: preview.headRevision,
          baseRevision: preview.baseRevision,
          treeRevision: preview.treeRevision,
          title: title.trim(),
          body: body.trim(),
        }),
        label("publishTimeout", "发布结果尚未确认。请重新读取草稿 PR 状态。"),
        120_000,
      );
      if (mounted.current) setPreview({ ...preview, receipt });
    });
  };
  const href = preview?.receipt?.url && safeGithubUrl(preview.receipt.url);

  return (
    <div className="wb-secretary-github-reply wb-secretary-draft-pr">
      <button
        type="button"
        className="wb-secretary-task-open"
        aria-expanded={expanded}
        aria-controls={panelId}
        disabled={disabled || Boolean(action)}
        onClick={() => {
          setExpanded(!expanded);
          if (!expanded) read();
        }}
      >
        <GitPullRequestDraft aria-hidden="true" />
        {preview?.receipt?.status === "published"
          ? label("published", "已创建草稿 PR")
          : label("preview", "预览草稿 PR")}
      </button>
      {expanded && (
        <div id={panelId} className="wb-secretary-form wb-secretary-draft-card">
          {action === "read" && (
            <p className="wb-secretary-github-loading" role="status">
              <LoaderCircle className="animate-spin" aria-hidden="true" />
              {label("loading", "正在读取工作树变更…")}
            </p>
          )}
          {(error || preview?.receipt?.error) && (
            <p className="wb-secretary-task-error" role="alert">
              {error || preview?.receipt?.error}
            </p>
          )}
          {preview && (
            <>
              <p className="wb-secretary-draft-target">
                <strong>{preview.repository}</strong>
                {preview.login && <small>@{preview.login}</small>}
              </p>
              <dl className="wb-secretary-worktree">
                <dt>{label("base", "目标分支")}</dt>
                <dd>
                  <code>{preview.baseBranch}</code>
                </dd>
                <dt>{label("head", "工作分支")}</dt>
                <dd>
                  <code>{preview.headBranch}</code>
                </dd>
              </dl>
              {preview.changes.length > 0 && (
                <details className="wb-secretary-change-list" open>
                  <summary>
                    {label("files", "{{count}} 个变更文件", {
                      count: preview.changedFileCount,
                    })}
                  </summary>
                  <ul>
                    {preview.changes.map((change, index) => (
                      <li key={`${change.path}:${index}`}>
                        <code>{change.status}</code>
                        <span>{change.path}</span>
                      </li>
                    ))}
                  </ul>
                  {preview.changedFileCount > preview.changes.length && (
                    <p className="wb-secretary-note">
                      {label("moreFiles", "另有 {{count}} 个变更文件。", {
                        count:
                          preview.changedFileCount - preview.changes.length,
                      })}
                    </p>
                  )}
                </details>
              )}
              {(preview.patch ||
                (preview.patchTruncated && !preview.receipt)) && (
                <details className="wb-secretary-change-list">
                  <summary>{label("patch", "查看差异")}</summary>
                  <pre className="wb-secretary-draft-patch">
                    {preview.patch}
                  </pre>
                  {preview.patchTruncated && (
                    <p className="wb-secretary-note">
                      {label(
                        "patchTruncated",
                        "预览仅显示部分差异。发布前可在工作树中查看完整变更。",
                      )}
                    </p>
                  )}
                </details>
              )}
              <label>
                {label("title", "PR 标题")}
                <input
                  value={title}
                  readOnly={Boolean(preview.receipt || action)}
                  maxLength={200}
                  onChange={(event) =>
                    setEdits((old) => ({ ...old, title: event.target.value }))
                  }
                />
              </label>
              <label>
                {label("body", "PR 正文")}
                <textarea
                  value={body}
                  readOnly={Boolean(preview.receipt || action)}
                  maxLength={16000}
                  rows={4}
                  onChange={(event) =>
                    setEdits((old) => ({ ...old, body: event.target.value }))
                  }
                />
              </label>
              {preview.receipt?.status === "pending" && (
                <p className="wb-secretary-note">
                  {label(
                    "pending",
                    "发布结果待确认。重试会核对并继续同一次发布。",
                  )}
                </p>
              )}
              {tooLong && (
                <p className="wb-secretary-task-error" role="alert">
                  {label("bodyLimit", "PR 正文最多 16,000 字节。")}
                </p>
              )}
              {preview.receipt?.status === "published" && (
                <p role="status" className="wb-secretary-note">
                  {label("published", "已创建草稿 PR")}
                  {preview.receipt.number ? ` #${preview.receipt.number}` : ""}
                  {preview.receipt.lifecycle &&
                    ` · ${label(`lifecycle.${preview.receipt.lifecycle}`, lifecycleLabels[preview.receipt.lifecycle])}`}
                </p>
              )}
            </>
          )}
          <div className="wb-secretary-form-actions">
            {preview?.receipt?.status === "published" ? (
              <>
                <button
                  type="button"
                  disabled={Boolean(action) || disabled}
                  onClick={read}
                >
                  <RefreshCw aria-hidden="true" />
                  {label("refreshStatus", "刷新 PR 状态")}
                </button>
                {href && (
                  <button
                    type="button"
                    onClick={() => {
                      void settingsApi.openExternal(href).catch((cause) => {
                        if (mounted.current) setError(agentErrorMessage(cause));
                      });
                    }}
                  >
                    <ArrowUpRight aria-hidden="true" />
                    {label("open", "在 GitHub 查看草稿 PR")}
                  </button>
                )}
              </>
            ) : (
              <>
                {(preview || needsRefresh) && (
                  <button
                    type="button"
                    disabled={Boolean(action) || disabled}
                    onClick={read}
                  >
                    <RefreshCw aria-hidden="true" />
                    {label("refresh", "重新预览")}
                  </button>
                )}
                {preview && (
                  <button
                    type="button"
                    disabled={
                      Boolean(action) ||
                      disabled ||
                      needsRefresh ||
                      !title.trim() ||
                      tooLong
                    }
                    onClick={publish}
                  >
                    {action === "publish" ? (
                      <LoaderCircle
                        className="animate-spin"
                        aria-hidden="true"
                      />
                    ) : (
                      <GitPullRequestDraft aria-hidden="true" />
                    )}
                    {preview.receipt?.status === "pending"
                      ? label("retry", "重试推送并创建草稿 PR")
                      : label("publish", "推送分支并创建草稿 PR")}
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
