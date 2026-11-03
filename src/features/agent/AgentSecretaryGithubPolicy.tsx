import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ArrowUpRight,
  ChevronRight,
  ListChecks,
  Plus,
  Save,
  Trash2,
} from "lucide-react";
import type {
  AgentSecretaryGithubPolicy as GithubPolicy,
  AgentSecretaryGithubRule,
  AgentSecretaryGithubRuleKind,
  AgentSecretaryTask,
} from "@/types/agent";
import { safeGithubUrl } from "./secretaryRequests";

const kinds: AgentSecretaryGithubRuleKind[] = [
  "issue",
  "pull_request",
  "comment",
];
const outcomes = {
  queued: "等待分派",
  dispatched: "已分派",
  failed: "分派失败",
};
type EditableRule = Omit<AgentSecretaryGithubRule, "actors"> & {
  actorsText: string;
};
type Draft = { enabled: boolean; rules: EditableRule[]; revision: number };

const copyPolicy = ({ enabled, revision, rules }: GithubPolicy): Draft => ({
  enabled,
  revision,
  rules: rules.map(({ actors, ...rule }) => ({
    ...rule,
    actorsText: actors.join(", "),
  })),
});

function savedRules(rules: EditableRule[]): AgentSecretaryGithubRule[] {
  return rules.map(({ actorsText, ...rule }) => ({
    ...rule,
    name: rule.name.trim(),
    keyword: rule.keyword.trim().toLowerCase(),
    instructions: rule.instructions.trim(),
    actors: [
      ...new Set(
        actorsText
          .split(/[\s,，]+/)
          .map((actor) => actor.replace(/^@/, "").toLowerCase())
          .filter(Boolean),
      ),
    ],
  }));
}

export function AgentSecretaryGithubPolicy({
  policy,
  monitoring,
  disabled,
  tasks,
  onSave,
  onOpenTask,
  onOpenSource,
}: {
  policy: GithubPolicy;
  monitoring: boolean;
  disabled: boolean;
  tasks: AgentSecretaryTask[];
  onSave: (
    enabled: boolean,
    rules: AgentSecretaryGithubRule[],
    expectedRevision: number,
  ) => Promise<GithubPolicy | undefined>;
  onOpenTask: (sessionId: string) => void;
  onOpenSource: (url: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const label = (
    key: string,
    defaultValue: string,
    values?: Record<string, unknown>,
  ) => t(`agentSecretary.github.policy.${key}`, { defaultValue, ...values });
  const [draft, setDraft] = useState<Draft>();
  const [editing, setEditing] = useState<string>();
  const config = draft ?? copyPolicy(policy);
  const selected = config.rules.find((rule) => rule.id === editing);
  const rules = savedRules(config.rules);
  const conflict = draft && draft.revision !== policy.revision;
  const invalid =
    rules.some(
      (rule) =>
        !rule.name ||
        !rule.keyword ||
        !rule.instructions ||
        !rule.actors.length ||
        !rule.kinds.length,
    ) ||
    (config.enabled && !rules.some((rule) => rule.enabled));

  const change = (update: (state: Draft) => Draft) =>
    setDraft((old) => update(old ?? copyPolicy(policy)));
  const editRule = (id: string, patch: Partial<EditableRule>) =>
    change((old) => ({
      ...old,
      rules: old.rules.map((rule) =>
        rule.id === id ? { ...rule, ...patch } : rule,
      ),
    }));
  const addRule = () => {
    const id = crypto.randomUUID();
    const next: EditableRule = {
      id,
      name: "",
      enabled: true,
      actorsText: "",
      kinds: ["issue"],
      keyword: "",
      instructions: "",
    };
    change((old) => ({ ...old, rules: [...old.rules, next] }));
    setEditing(id);
  };
  const toggleEnabled = (enabled: boolean) => {
    if (!enabled && policy.enabled) {
      void onSave(false, policy.rules, policy.revision).then((saved) => {
        if (!saved) return;
        setDraft(
          (old) =>
            old && {
              ...old,
              enabled: false,
              revision:
                old.revision === policy.revision
                  ? saved.revision
                  : old.revision,
            },
        );
      });
      return;
    }
    change((old) => ({ ...old, enabled }));
  };

  return (
    <details className="wb-secretary-policy">
      <summary>
        <ChevronRight
          aria-hidden="true"
          className="wb-secretary-policy-chevron"
        />
        <ListChecks aria-hidden="true" />
        <strong>{label("title", "自动分派")}</strong>
        <small>
          {policy.enabled ? label("on", "已开启") : label("off", "已关闭")}
        </small>
      </summary>
      <div className="wb-secretary-policy-content">
        <p className="wb-secretary-note">
          {label(
            "description",
            "只有来源、账号和指令都符合规则时才自动交办。工作要求来自保存的规则，文件变更仍需你授权。首次同步建立基线，之后每次同步最多交办两项。",
          )}
        </p>
        <fieldset disabled={disabled} className="wb-secretary-policy-editor">
          <label className="wb-secretary-github-monitor">
            <input
              type="checkbox"
              checked={policy.enabled || config.enabled}
              disabled={!monitoring && !policy.enabled && !config.enabled}
              onChange={(event) => toggleEnabled(event.target.checked)}
            />
            {label("enable", "开启自动分派")}
          </label>
          <p className="wb-secretary-note">
            {label("toggleHint", "关闭后立即生效。开启或编辑规则需要保存。")}
          </p>
          {!monitoring && (
            <p className="wb-secretary-note">
              {label("monitoringOff", "请先开启自动收件，再开启自动分派。")}
            </p>
          )}
          <div className="wb-secretary-policy-rules">
            {config.rules.map((rule) => (
              <button
                key={rule.id}
                type="button"
                aria-pressed={selected?.id === rule.id}
                className="wb-secretary-task-toggle"
                onClick={() => setEditing(rule.id)}
              >
                <strong>
                  {rule.name || label("untitledRule", "未命名规则")}
                </strong>
                <small>
                  {rule.enabled
                    ? label("on", "已开启")
                    : label("off", "已关闭")}
                </small>
              </button>
            ))}
            <button
              type="button"
              className="wb-secretary-task-open"
              disabled={rules.length >= 8}
              onClick={addRule}
            >
              <Plus aria-hidden="true" />
              {label("add", "添加规则")}
            </button>
          </div>
          {selected && (
            <div className="wb-secretary-form wb-secretary-policy-fields">
              <div className="wb-secretary-policy-columns">
                <label>
                  {label("name", "规则名称")}
                  <input
                    maxLength={100}
                    value={selected.name}
                    onChange={(event) =>
                      editRule(selected.id, { name: event.target.value })
                    }
                  />
                </label>
                <label>
                  {label("keyword", "指令关键词")}
                  <input
                    maxLength={48}
                    value={selected.keyword}
                    onChange={(event) =>
                      editRule(selected.id, { keyword: event.target.value })
                    }
                    placeholder="triage"
                    spellCheck={false}
                  />
                </label>
              </div>
              <p className="wb-secretary-note">
                {label("keywordHint", "消息首行须写 /loli {{keyword}}。", {
                  keyword: selected.keyword.trim() || "triage",
                })}
              </p>
              <label>
                {label("actors", "允许的 GitHub 账号")}
                <input
                  value={selected.actorsText}
                  onChange={(event) =>
                    editRule(selected.id, { actorsText: event.target.value })
                  }
                  placeholder="alice, bob"
                  spellCheck={false}
                />
              </label>
              <p className="wb-secretary-note">
                {label("actorsHint", "每条规则最多 8 个账号，用逗号分隔。")}
              </p>
              <fieldset className="wb-secretary-policy-kinds">
                <legend>{label("sources", "匹配来源")}</legend>
                {kinds.map((kind) => (
                  <label key={kind} className="wb-secretary-github-monitor">
                    <input
                      type="checkbox"
                      checked={selected.kinds.includes(kind)}
                      onChange={(event) =>
                        editRule(selected.id, {
                          kinds: event.target.checked
                            ? [...selected.kinds, kind]
                            : selected.kinds.filter((value) => value !== kind),
                        })
                      }
                    />
                    {t(`agentSecretary.github.kind.${kind}`, {
                      defaultValue:
                        kind === "comment"
                          ? "评论"
                          : kind === "issue"
                            ? "Issue"
                            : "PR",
                    })}
                  </label>
                ))}
              </fieldset>
              <label>
                {label("instructions", "执行要求")}
                <textarea
                  rows={3}
                  maxLength={8000}
                  value={selected.instructions}
                  onChange={(event) =>
                    editRule(selected.id, { instructions: event.target.value })
                  }
                />
              </label>
              <div className="wb-secretary-form-actions">
                <label className="wb-secretary-github-monitor">
                  <input
                    type="checkbox"
                    checked={selected.enabled}
                    onChange={(event) =>
                      editRule(selected.id, { enabled: event.target.checked })
                    }
                  />
                  {label("ruleEnabled", "启用这条规则")}
                </label>
                <button
                  type="button"
                  onClick={() => {
                    change((old) => ({
                      ...old,
                      rules: old.rules.filter(
                        (rule) => rule.id !== selected.id,
                      ),
                    }));
                    setEditing(undefined);
                  }}
                >
                  <Trash2 aria-hidden="true" />
                  {label("remove", "删除规则")}
                </button>
              </div>
            </div>
          )}
          {conflict && (
            <p className="wb-secretary-task-error" role="alert">
              {label(
                "conflict",
                "已保存的设置有更新。请放弃这份修改后重新编辑。",
              )}
            </p>
          )}
          {draft && invalid && !conflict && (
            <p className="wb-secretary-note">
              {label(
                "invalid",
                "请填全规则的名称、关键词、账号、来源和执行要求。开启自动分派需要至少一条启用的规则。",
              )}
            </p>
          )}
          {draft && (
            <div className="wb-secretary-form-actions">
              <button
                type="button"
                onClick={() => {
                  setDraft(undefined);
                  setEditing(undefined);
                }}
              >
                {label("discard", "放弃修改")}
              </button>
              <button
                type="button"
                disabled={Boolean(
                  conflict || invalid || (config.enabled && !monitoring),
                )}
                onClick={() => {
                  void onSave(config.enabled, rules, config.revision).then(
                    (saved) => {
                      if (saved) setDraft(undefined);
                    },
                  );
                }}
              >
                <Save aria-hidden="true" />
                {label("save", "保存自动分派设置")}
              </button>
            </div>
          )}
        </fieldset>
        <details className="wb-secretary-policy-history">
          <summary>
            {label("history", "命中记录")}{" "}
            <small>{policy.decisions.length}</small>
          </summary>
          {policy.decisions.length === 0 && (
            <p className="wb-secretary-note">
              {label("emptyHistory", "符合规则的条目会显示在这里。")}
            </p>
          )}
          <ol>
            {[...policy.decisions]
              .sort((a, b) => b.decidedAt - a.decidedAt)
              .map((decision) => {
                const task = tasks.find(
                  (entry) => entry.id === decision.taskId,
                );
                const url = safeGithubUrl(decision.url);
                return (
                  <li
                    key={`${decision.itemId}:${decision.ruleId}:${decision.decidedAt}`}
                  >
                    <div>
                      <strong>{decision.title}</strong>
                      <small>
                        {decision.ruleName} ·{" "}
                        {new Date(decision.decidedAt).toLocaleString(
                          i18n.resolvedLanguage || undefined,
                        )}
                      </small>
                    </div>
                    <span
                      className="wb-secretary-task-status"
                      data-status={decision.status}
                    >
                      {label(
                        `status.${decision.status}`,
                        outcomes[decision.status],
                      )}
                    </span>
                    {task && (
                      <button
                        type="button"
                        className="wb-secretary-task-open"
                        disabled={disabled}
                        onClick={() => onOpenTask(task.sessionId)}
                      >
                        {label("openTask", "查看任务")}
                      </button>
                    )}
                    {url && (
                      <button
                        type="button"
                        className="wb-secretary-task-open"
                        disabled={disabled}
                        aria-label={label("openSource", "在 GitHub 查看条目")}
                        onClick={() => onOpenSource(url)}
                      >
                        <ArrowUpRight aria-hidden="true" />
                      </button>
                    )}
                    {decision.error && (
                      <p className="wb-secretary-task-error">
                        {decision.error}
                      </p>
                    )}
                  </li>
                );
              })}
          </ol>
        </details>
      </div>
    </details>
  );
}
