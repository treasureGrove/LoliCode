import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input, fieldClass } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { settingsApi } from "@/lib/api";
import type {
  AgentQuestion,
  AgentQuestionAnswer,
  AgentQuestionField,
  AgentAnswerValue,
} from "@/types/agent";
import { agentErrorMessage } from "@/hooks/useAgentSnapshot";

const validValue = (value: unknown): value is AgentAnswerValue =>
  typeof value === "string" ||
  typeof value === "boolean" ||
  (typeof value === "number" && Number.isFinite(value)) ||
  (Array.isArray(value) && value.every((item) => typeof item === "string"));

function isVisible(
  field: AgentQuestionField,
  values: Record<string, unknown>,
  fields: AgentQuestionField[],
  seen = new Set<string>(),
) {
  if (field.hidden) return false;
  if (seen.has(field.key)) return false;
  const nextSeen = new Set(seen).add(field.key);
  return (field.when ?? []).every((raw) => {
    if (!raw || typeof raw !== "object") return false;
    const condition = raw as { key?: string; op?: string; value?: unknown };
    const dependency = fields.find(
      (candidate) => candidate.key === condition.key,
    );
    if (
      !condition.key ||
      !dependency ||
      values[condition.key] === undefined ||
      !isVisible(dependency, values, fields, nextSeen)
    )
      return false;
    const value = values[condition.key];
    const hit = Array.isArray(value)
      ? value.some((item) => item === condition.value)
      : value === condition.value;
    return condition.op === "eq" ? hit : condition.op === "neq" ? !hit : false;
  });
}

export function AgentQuestionCard({
  question,
  onReply,
  onReject,
}: {
  question: AgentQuestion;
  onReply: (answer: AgentQuestionAnswer) => Promise<void>;
  onReject: () => Promise<void>;
}) {
  const [values, setValues] = useState<Record<string, unknown>>(() =>
    Object.fromEntries(
      question.fields
        .filter((field) => validValue(field.default))
        .map((field) => [field.key, field.default]),
    ),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const visible = question.fields.filter((field) =>
    isVisible(field, values, question.fields),
  );
  const external = visible.some((field) => field.type === "external");
  const unsupported =
    question.fields.some((field) =>
      (field.when ?? []).some(
        (raw) =>
          !raw ||
          typeof raw !== "object" ||
          !["eq", "neq"].includes(String((raw as { op?: unknown }).op)),
      ),
    ) ||
    visible.some(
      (field) =>
        ![
          "string",
          "number",
          "integer",
          "boolean",
          "multiselect",
          "external",
        ].includes(field.type),
    );
  const setValue = (key: string, value: unknown) =>
    setValues((old) => ({ ...old, [key]: value }));
  const submit = async (reject = false) => {
    if (pending.current) return;
    setError(null);
    const answer: AgentQuestionAnswer = {};
    if (!reject) {
      if (external || unsupported) return;
      for (const field of question.fields) {
        if (!isVisible(field, values, question.fields)) continue;
        let value = values[field.key];
        const title = field.title || field.key;
        if (field.type === "number" || field.type === "integer") {
          if (value !== undefined && value !== "") value = Number(value);
          if (
            value !== undefined &&
            value !== "" &&
            (typeof value !== "number" ||
              !Number.isFinite(value) ||
              (field.type === "integer" && !Number.isInteger(value)))
          ) {
            setError(
              `${title}请填写${field.type === "integer" ? "整数" : "数字"}。`,
            );
            return;
          }
          if (
            typeof value === "number" &&
            ((field.minimum != null && value < field.minimum) ||
              (field.maximum != null && value > field.maximum))
          ) {
            setError(`${title}超出了允许的范围。`);
            return;
          }
        }
        if (
          field.required &&
          (value === undefined ||
            value === "" ||
            (Array.isArray(value) && value.length === 0))
        ) {
          setError(`请填写${title}。`);
          return;
        }
        if (
          typeof value === "string" &&
          ((field.minLength != null && value.length < field.minLength) ||
            (field.maxLength != null && value.length > field.maxLength))
        ) {
          setError(`${title}的长度不符合要求。`);
          return;
        }
        if (
          Array.isArray(value) &&
          ((field.minItems != null && value.length < field.minItems) ||
            (field.maxItems != null && value.length > field.maxItems))
        ) {
          setError(`${title}的选项数量不符合要求。`);
          return;
        }
        if (validValue(value)) answer[field.key] = value;
      }
    }
    pending.current = true;
    setBusy(true);
    try {
      if (reject) await onReject();
      else await onReply(answer);
    } catch (cause) {
      setError(agentErrorMessage(cause));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  return (
    <form
      aria-label={question.title}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      className="space-y-3 rounded-panel border border-border-strong bg-subtle p-4"
    >
      <h3 className="text-body font-medium">{question.title}</h3>
      {visible.map((field) => {
        const title = field.title || field.key;
        const id = `agent-question-${question.id}-${field.key}`;
        const value = values[field.key];
        return (
          <div key={field.key} className="space-y-1.5">
            <Label htmlFor={id}>
              {title}
              {field.required && (
                <span className="ml-1 text-fg-3">（必填）</span>
              )}
            </Label>
            {field.description && (
              <p className="whitespace-pre-wrap break-words text-caption text-fg-3">
                {field.description}
              </p>
            )}
            {field.type === "external" ? (
              <div className="text-caption text-fg-2">
                此问题需要在运行工具中处理。
                {field.url && /^https?:\/\//i.test(field.url) && (
                  <Button
                    type="button"
                    variant="quiet"
                    size="compact"
                    onClick={() =>
                      void settingsApi
                        .openExternal(field.url!)
                        .catch((cause) => setError(agentErrorMessage(cause)))
                    }
                  >
                    打开工具页面
                  </Button>
                )}
              </div>
            ) : field.type === "boolean" ? (
              <select
                id={id}
                value={typeof value === "boolean" ? String(value) : ""}
                className={fieldClass}
                disabled={busy}
                onChange={(event) =>
                  setValue(
                    field.key,
                    event.target.value === ""
                      ? undefined
                      : event.target.value === "true",
                  )
                }
              >
                <option value="">请选择</option>
                <option value="true">是</option>
                <option value="false">否</option>
              </select>
            ) : field.type === "multiselect" ? (
              <div className="space-y-2">
                {(field.options ?? []).map((option) => (
                  <label
                    key={option.value}
                    className="flex items-start gap-2 text-body"
                  >
                    <Checkbox
                      aria-label={`${title}：${option.label}`}
                      disabled={busy}
                      checked={
                        Array.isArray(value) && value.includes(option.value)
                      }
                      onCheckedChange={(checked) => {
                        const selected = Array.isArray(value)
                          ? value.filter(
                              (item): item is string =>
                                typeof item === "string",
                            )
                          : [];
                        setValue(
                          field.key,
                          checked
                            ? [...selected, option.value]
                            : selected.filter((item) => item !== option.value),
                        );
                      }}
                    />
                    <span>
                      {option.label}
                      {option.description && (
                        <span className="ml-2 text-caption text-fg-3">
                          {option.description}
                        </span>
                      )}
                    </span>
                  </label>
                ))}
                {field.custom && (
                  <Input
                    aria-label={`${title}：其他选择`}
                    disabled={busy}
                    placeholder="其他选择"
                    value={
                      Array.isArray(value)
                        ? value.find(
                            (item) =>
                              !field.options?.some(
                                (option) => option.value === item,
                              ),
                          ) || ""
                        : ""
                    }
                    onChange={(event) =>
                      setValue(field.key, [
                        ...(Array.isArray(value)
                          ? value.filter((item) =>
                              field.options?.some(
                                (option) => option.value === item,
                              ),
                            )
                          : []),
                        ...(event.target.value ? [event.target.value] : []),
                      ])
                    }
                  />
                )}
              </div>
            ) : (
              <>
                {field.options?.length ? (
                  <div className="flex flex-wrap gap-2">
                    {field.options.map((option) => (
                      <Button
                        type="button"
                        key={option.value}
                        variant={value === option.value ? "solid" : "neutral"}
                        disabled={busy}
                        aria-pressed={value === option.value}
                        title={option.description || undefined}
                        onClick={() => setValue(field.key, option.value)}
                      >
                        {option.label}
                      </Button>
                    ))}
                  </div>
                ) : null}
                {(!field.options?.length || field.custom) && (
                  <Input
                    id={id}
                    aria-label={title}
                    disabled={busy}
                    type={
                      field.type === "number" || field.type === "integer"
                        ? "number"
                        : "text"
                    }
                    step={field.type === "integer" ? 1 : "any"}
                    min={field.minimum ?? undefined}
                    max={field.maximum ?? undefined}
                    maxLength={field.maxLength ?? undefined}
                    placeholder={
                      field.placeholder ||
                      (field.custom ? "也可以输入其他答案" : "填写答案")
                    }
                    value={
                      typeof value === "string" || typeof value === "number"
                        ? value
                        : ""
                    }
                    onChange={(event) =>
                      setValue(
                        field.key,
                        field.type === "number" || field.type === "integer"
                          ? event.target.value === ""
                            ? ""
                            : Number(event.target.value)
                          : event.target.value,
                      )
                    }
                  />
                )}
              </>
            )}
          </div>
        );
      })}
      {unsupported && (
        <p role="status" className="text-caption text-fg-2">
          此问题需要在运行工具中处理，当前不能代为提交。
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" disabled={busy || external || unsupported}>
          {busy ? "正在提交…" : "提交答案"}
        </Button>
        <Button
          type="button"
          variant="quiet"
          disabled={busy}
          onClick={() => void submit(true)}
        >
          取消这次问题
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-caption text-danger-text">
          {error}
        </p>
      )}
    </form>
  );
}
