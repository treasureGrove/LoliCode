import mascot from "@/assets/brand/lolicode-maid.png";
import portrait from "@/assets/brand/lolicode-icon.png";
import { cn } from "@/lib/utils";

export default function LolicodeMascot({
  className,
  variant = "portrait",
  decorative = true,
}: {
  className?: string;
  variant?: "portrait" | "full";
  decorative?: boolean;
}) {
  return (
    <img
      src={variant === "full" ? mascot : portrait}
      alt={decorative ? "" : "LoliCode 女仆吉祥物"}
      aria-hidden={decorative || undefined}
      draggable={false}
      className={cn("lolicode-mascot", className)}
      style={{ objectFit: "contain" }}
      decoding="async"
    />
  );
}
