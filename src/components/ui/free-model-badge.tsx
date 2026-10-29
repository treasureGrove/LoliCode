/** Only render for models explicitly supplied by the LoliCode public channel. */
export function FreeModelBadge() {
  return (
    <span
      className="inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-[10px] font-medium leading-none text-emerald-700 bg-emerald-500/10 dark:text-emerald-300"
      title="公益模型，使用每日免费额度"
    >
      free
    </span>
  );
}
