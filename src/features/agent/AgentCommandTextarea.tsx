import {
  forwardRef,
  useId,
  useRef,
  useState,
  type TextareaHTMLAttributes,
} from "react";
import { ListChecks, Minimize2, Target } from "lucide-react";

const commands = [
  {
    name: "/plan",
    label: "先制定计划",
    description: "先分析并提出方案，确认后推进执行。",
    icon: ListChecks,
  },
  {
    name: "/goal",
    label: "持续推进目标",
    description: "围绕目标连续工作，可随时暂停、继续或修改。",
    icon: Target,
  },
  {
    name: "/compact",
    label: "压缩会话上下文",
    description: "整理当前对话，保留关键信息以继续工作。",
    icon: Minimize2,
  },
] as const;

/** Only normalize native command names; preserve the user's task verbatim. */
export function normalizeAgentCommand(text: string): string {
  return text.replace(/^\/(plan|goal|compact)(?=\s|$)/i, (name) =>
    name.toLowerCase(),
  );
}

interface AgentCommandTextareaProps
  extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value"> {
  value: string;
  onSelectCommand: (value: string) => void;
}

export const AgentCommandTextarea = forwardRef<
  HTMLTextAreaElement,
  AgentCommandTextareaProps
>(function AgentCommandTextarea(
  {
    value,
    onSelectCommand,
    onKeyDown,
    onChange,
    onFocus,
    onBlur,
    onCompositionStart,
    onCompositionEnd,
    disabled,
    ...props
  },
  ref,
) {
  const menuId = useId();
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const composing = useRef(false);
  const query = /^\s*(\/[^\s]*)$/.exec(value)?.[1].toLowerCase();
  const matches = query
    ? commands.filter((command) => command.name.startsWith(query))
    : [];
  const open = focused && !disabled && !dismissed && matches.length > 0;
  const selectedIndex = Math.min(activeIndex, Math.max(0, matches.length - 1));
  const select = (index: number) => {
    const command = matches[index];
    if (!command) return;
    onSelectCommand(command.name + " ");
    setDismissed(true);
  };
  return (
    <>
      {open && (
        <div className="wb-command-menu">
          <div className="wb-command-menu-heading">
            <span>会话命令</span>
            <small>↑ ↓ 选择 · Tab / Enter 填入 · Esc 关闭</small>
          </div>
          <div id={menuId} role="listbox" aria-label="会话命令">
            {matches.map((command, index) => (
              <button
                key={command.name}
                id={`${menuId}-${index}`}
                type="button"
                role="option"
                tabIndex={-1}
                aria-selected={selectedIndex === index}
                onMouseDown={(event) => event.preventDefault()}
                onMouseMove={() => setActiveIndex(index)}
                onClick={() => select(index)}
              >
                <command.icon size={17} aria-hidden="true" />
                <span>
                  <strong>
                    {command.name} <span>{command.label}</span>
                  </strong>
                  <small>{command.description}</small>
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
      <textarea
        {...props}
        ref={ref}
        value={value}
        disabled={disabled}
        aria-autocomplete="list"
        aria-haspopup="listbox"
        aria-controls={open ? menuId : undefined}
        aria-activedescendant={open ? `${menuId}-${selectedIndex}` : undefined}
        onFocus={(event) => {
          setFocused(true);
          onFocus?.(event);
        }}
        onBlur={(event) => {
          setFocused(false);
          onBlur?.(event);
        }}
        onChange={(event) => {
          setDismissed(false);
          setActiveIndex(0);
          onChange?.(event);
        }}
        onCompositionStart={(event) => {
          composing.current = true;
          onCompositionStart?.(event);
        }}
        onCompositionEnd={(event) => {
          composing.current = false;
          onCompositionEnd?.(event);
        }}
        onKeyDown={(event) => {
          // Some IMEs report keyCode 229 instead of isComposing for confirmation.
          if (
            composing.current ||
            event.nativeEvent.isComposing ||
            event.keyCode === 229
          )
            return;
          if (open && !event.ctrlKey && !event.metaKey && !event.altKey) {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              setActiveIndex(
                (selectedIndex +
                  (event.key === "ArrowDown" ? 1 : -1) +
                  matches.length) %
                  matches.length,
              );
              return;
            }
            if (
              (event.key === "Enter" || event.key === "Tab") &&
              !event.shiftKey
            ) {
              event.preventDefault();
              select(selectedIndex);
              return;
            }
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              setDismissed(true);
              return;
            }
          }
          onKeyDown?.(event);
        }}
      />
    </>
  );
});
