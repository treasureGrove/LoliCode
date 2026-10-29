import { cn } from "@/lib/utils";

/** A two-tone mark that inherits its ink and paper from the surrounding theme. */
export function TaijiMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 64 64"
      fill="none"
      aria-hidden="true"
      className={cn("tai-mark", className)}
    >
      <circle
        cx="32"
        cy="32"
        r="30"
        stroke="currentColor"
        strokeWidth="0.7"
        opacity="0.4"
      />
      <g className="tai-mark-turn">
        <circle cx="32" cy="32" r="25" fill="var(--tai-paper, #f5f2e9)" />
        <path
          d="M32 7a25 25 0 0 1 0 50 12.5 12.5 0 0 0 0-25 12.5 12.5 0 0 1 0-25Z"
          fill="var(--tai-ink, #202b28)"
        />
        <circle cx="32" cy="19.5" r="3.2" fill="var(--tai-paper, #f5f2e9)" />
        <circle cx="32" cy="44.5" r="3.2" fill="var(--tai-ink, #202b28)" />
      </g>
    </svg>
  );
}
