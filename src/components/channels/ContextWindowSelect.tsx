/** Select only declared windows; no inferred tiers or free-form request fields. */
export function ContextWindowSelect({
  windows,
  defaultLimit,
  value,
  disabled,
  onSelect,
  label = "上下文窗口",
  className = "",
}: {
  windows?: number[] | null;
  defaultLimit?: number | null;
  value?: number | null;
  disabled?: boolean;
  onSelect: (limit: number | null) => void;
  label?: string;
  className?: string;
}) {
  const options = [...new Set(windows ?? [])]
    .filter((limit) => Number.isSafeInteger(limit) && limit > 0)
    .sort((a, b) => a - b);
  if (options.length < 2 && value == null) return null;
  const stale = value != null && !options.includes(value);
  return (
    <select
      aria-label={label}
      className={`rounded-md border border-border bg-transparent px-2 py-1 text-xs text-fg-2 ${className}`}
      value={value == null ? "default" : String(value)}
      disabled={disabled}
      onChange={(event) =>
        onSelect(
          event.target.value === "default" ? null : Number(event.target.value),
        )
      }
    >
      <option value="default">
        渠道默认
        {defaultLimit ? ` · ${defaultLimit.toLocaleString()} tokens` : ""}
      </option>
      {stale && (
        <option value={String(value)} disabled>
          {value.toLocaleString()} tokens（当前目录未提供）
        </option>
      )}
      {options.map((limit) => (
        <option key={limit} value={String(limit)}>
          {limit.toLocaleString()} tokens
        </option>
      ))}
    </select>
  );
}
