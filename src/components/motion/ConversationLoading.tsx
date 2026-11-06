export function ConversationLoading({ label }: { label?: string }) {
  return (
    <div
      role={label ? "status" : undefined}
      aria-hidden={!label || undefined}
      data-conversation-loading
      className="mx-auto flex w-full max-w-3xl flex-col gap-5 py-1"
    >
      {label && <span className="sr-only">{label}</span>}
      <div
        aria-hidden="true"
        className="h-10 w-2/5 self-end rounded-xl bg-subtle"
      />
      <div
        aria-hidden="true"
        className="flex max-w-[78%] flex-col gap-2 rounded-xl bg-subtle p-4"
      >
        <span className="h-2 w-11/12 rounded-full bg-border/50" />
        <span className="h-2 w-3/4 rounded-full bg-border/50" />
        <span className="h-2 w-1/2 rounded-full bg-border/50" />
      </div>
    </div>
  );
}
