import brandMark from "@/assets/brand/lolicode.svg";
import { cn } from "@/lib/utils";

export function LolicodeMark({ className }: { className?: string }) {
  return (
    <img
      src={brandMark}
      alt=""
      aria-hidden="true"
      className={cn("lolicode-mark", className)}
    />
  );
}
