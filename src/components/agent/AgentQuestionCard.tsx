import { useEffect, useId, useRef, useState } from "react";
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
import "./agent-question.css";

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

function validateAnswer(field: AgentQuestionField, rawValue: unknown) {
  let value = rawValue;
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
      return {
        error: `${title}请填写${field.type === "integer" ? "整数" : "数字"}。`,
      };
    }
    if (
      typeof value === "number" &&
      ((field.minimum != null && value < field.minimum) ||
        (field.maximum != null && value > field.maximum))
    ) {
      return { error: `${title}超出了允许的范围。` };
    }
  }
  if (
    field.required &&
    (value === undefined ||
      (typeof value === "string" && !value.trim()) ||
      (Array.isArray(value) && value.length === 0))
  ) {
    return { error: `请填写${title}。` };
  }
  if (
    typeof value === "string" &&
    ((field.minLength != null && value.length < field.minLength) ||
      (field.maxLength != null && value.length > field.maxLength))
  ) {
    return { error: `${title}的长度不符合要求。` };
  }
  if (
    Array.isArray(value) &&
    ((field.minItems != null && value.length < field.minItems) ||
      (field.maxItems != null && value.length > field.maxItems))
  ) {
    return { error: `${title}的选项数量不符合要求。` };
  }
  return { value };
}

interface QuestionProps {
  question: AgentQuestion;
  onReply: (answer: AgentQuestionAnswer) => Promise<void>;
  onReject: () => Promise<void>;
}

export function AgentQuestionCard(props: QuestionProps) {
  return (
    <QuestionForm
      key={JSON.stringify([props.question.sessionId, props.question.id])}
      {...props}
    />
  );
}

function QuestionForm({ question, onReply, onReject }: QuestionProps) {
  const [values, setValues] = useState<Record<string, unknown>>(() =>
    Object.fromEntries(
      question.fields
        .filter((field) => validValue(field.default))
        .map((field) => [field.key, field.default]),
    ),
  );
  const [busy, setBusy] = useState(false);
  const [activeKey, setActiveKey] = useState<string | null>(
    () =>
      question.fields.find((field) => isVisible(field, values, question.fields))
        ?.key ?? null,
  );
  const [resolution, setResolution] = useState<"answered" | "rejected" | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const answerBody = useRef<HTMLDivElement>(null);
  const descriptionsId = useId();
  const locked = busy || resolution !== null;
  const visible = question.fields.filter((field) =>
    isVisible(field, values, question.fields),
  );
  const activeIndex = Math.max(
    0,
    visible.findIndex((field) => field.key === activeKey),
  );
  const currentField = visible[activeIndex];
  const isLast = activeIndex >= visible.length - 1;
  useEffect(() => {
    if (activeKey === null || !answerBody.current) return;
    answerBody.current.scrollTop = 0;
    answerBody.current
      .querySelector<HTMLElement>("textarea,input,select,button")
      ?.focus();
  }, [currentField?.key, activeKey]);
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
  const setValue = (key: string, value: unknown) => {
    setError(null);
    setValues((old) => ({ ...old, [key]: value }));
  };
  const navigate = (index: number) => {
    if (locked || !visible[index]) return;
    setError(null);
    setActiveKey(visible[index].key);
  };
  const submit = async (reject = false) => {
    if (pending.current || locked) return;
    setError(null);
    const answer: AgentQuestionAnswer = {};
    if (!reject) {
      if (external || unsupported) return;
      for (const field of visible) {
        const { value, error: validationError } = validateAnswer(
          field,
          values[field.key],
        );
        if (validationError) {
          setActiveKey(field.key);
          setError(validationError);
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
      setResolution(reject ? "rejected" : "answered");
    } catch (cause) {
      pending.current = false;
      setError(agentErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  };
  const continueAnswering = () => {
    if (locked) return;
    if (isLast) {
      void submit();
      return;
    }
    if (!currentField || currentField.type === "external" || unsupported)
      return;
    const { error: validationError } = validateAnswer(
      currentField,
      values[currentField.key],
    );
    if (validationError) {
      setError(validationError);
      return;
    }
    navigate(activeIndex + 1);
  };
  return (
    <form
      aria-label={question.title}
      aria-busy={busy}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        continueAnswering();
      }}
      className="agent-question-card"
    >
      <header className="agent-question-header">
        <p className="agent-question-eyebrow">需要你的回答</p>
        <h3 className="agent-question-heading">{question.title}</h3>
      </header>
      <div ref={answerBody} className="agent-question-body">
        {(currentField ? [currentField] : []).map((field) => {
          const title = field.title || field.key;
          const id = `agent-question-${question.id}-${field.key}`;
          const value = values[field.key];
          return (
            <div key={field.key} className="agent-question-field">
              <Label
                id={`${id}-title`}
                htmlFor={id}
                className="agent-question-title"
              >
                {title}
                {field.required && (
                  <span className="ml-1 text-fg-3">（必填）</span>
                )}
              </Label>
              {field.description && (
                <p id={`${id}-detail`} className="agent-question-detail">
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
                      disabled={locked}
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
                  aria-label={title}
                  aria-describedby={
                    field.description ? `${id}-detail` : undefined
                  }
                  value={typeof value === "boolean" ? String(value) : ""}
                  className={fieldClass}
                  disabled={locked}
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
                <div className="agent-question-options">
                  {(field.options ?? []).map((option) => (
                    <label
                      key={option.value}
                      className="agent-question-option agent-question-multiselect"
                      data-selected={
                        Array.isArray(value) && value.includes(option.value)
                      }
                    >
                      <Checkbox
                        aria-label={`${title}：${option.label}`}
                        disabled={locked}
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
                              : selected.filter(
                                  (item) => item !== option.value,
                                ),
                          );
                        }}
                      />
                      <span className="agent-question-option-copy">
                        <span className="agent-question-option-label">
                          {option.label}
                        </span>
                        {option.description && (
                          <span className="agent-question-option-description">
                            {option.description}
                          </span>
                        )}
                      </span>
                    </label>
                  ))}
                  {field.custom && (
                    <Input
                      aria-label={`${title}：其他选择`}
                      disabled={locked}
                      className="agent-question-input"
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
                    <div
                      role="group"
                      aria-label={`${title}选项`}
                      className="agent-question-options"
                    >
                      {field.options.map((option, optionIndex) => (
                        <Button
                          type="button"
                          key={option.value}
                          variant="quiet"
                          disabled={locked}
                          aria-pressed={value === option.value}
                          aria-label={option.label}
                          aria-describedby={
                            option.description
                              ? `${descriptionsId}-${field.key}-${optionIndex}`
                              : undefined
                          }
                          className="agent-question-option"
                          onClick={() => setValue(field.key, option.value)}
                        >
                          <span
                            aria-hidden="true"
                            className="agent-question-option-number"
                          >
                            {optionIndex + 1}
                          </span>
                          <span className="agent-question-option-copy">
                            <span className="agent-question-option-label">
                              {option.label}
                            </span>
                            {option.description && (
                              <span
                                id={`${descriptionsId}-${field.key}-${optionIndex}`}
                                className="agent-question-option-description"
                              >
                                {option.description}
                              </span>
                            )}
                          </span>
                        </Button>
                      ))}
                    </div>
                  ) : null}
                  {(!field.options?.length || field.custom) &&
                    (field.type === "string" ? (
                      <textarea
                        id={id}
                        aria-label={title}
                        disabled={locked}
                        className={`${fieldClass} agent-question-input`}
                        rows={2}
                        maxLength={field.maxLength ?? undefined}
                        placeholder={
                          field.placeholder ||
                          (field.custom
                            ? "也可以输入其他答案"
                            : "填写答案，Enter 继续，Shift+Enter 换行")
                        }
                        value={
                          typeof value === "string" &&
                          !field.options?.some(
                            (option) => option.value === value,
                          )
                            ? value
                            : ""
                        }
                        onChange={(event) =>
                          setValue(field.key, event.target.value)
                        }
                        onKeyDown={(event) => {
                          if (
                            event.key === "Enter" &&
                            !event.shiftKey &&
                            !event.nativeEvent.isComposing &&
                            event.nativeEvent.keyCode !== 229
                          ) {
                            event.preventDefault();
                            continueAnswering();
                          }
                        }}
                      />
                    ) : (
                      <Input
                        id={id}
                        aria-label={title}
                        disabled={locked}
                        className="agent-question-input"
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
                    ))}
                </>
              )}
            </div>
          );
        })}
      </div>
      {unsupported && (
        <p role="status" className="text-caption text-fg-2">
          此问题需要在运行工具中处理，当前不能代为提交。
        </p>
      )}
      <footer className="agent-question-footer">
        <div className="agent-question-pager">
          {visible.length > 1 && (
            <Button
              type="button"
              variant="quiet"
              disabled={locked || activeIndex === 0}
              onClick={() => navigate(activeIndex - 1)}
            >
              上一题
            </Button>
          )}
          {visible.length > 0 && (
            <span
              className="agent-question-progress"
              aria-live="polite"
              aria-atomic="true"
            >
              第 {activeIndex + 1} / {visible.length} 题
            </span>
          )}
        </div>
        <div className="agent-question-actions">
          <Button
            type="button"
            variant="quiet"
            disabled={locked}
            onClick={() => void submit(true)}
          >
            取消这次问题
          </Button>
          <Button
            type="submit"
            disabled={
              locked ||
              unsupported ||
              (isLast ? external : currentField?.type === "external")
            }
          >
            {busy
              ? "正在提交…"
              : resolution
                ? "已处理"
                : isLast
                  ? "提交答案"
                  : "下一题"}
          </Button>
        </div>
      </footer>
      {resolution && (
        <p role="status" className="text-caption text-fg-2">
          {resolution === "answered"
            ? "答案已提交，等待 Agent 继续。"
            : "已取消这次问题，等待 Agent 继续。"}
        </p>
      )}
      {error && (
        <p role="alert" className="text-caption text-danger-text">
          {error}
        </p>
      )}
    </form>
  );
}
