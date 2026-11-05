import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export function AgentOpenWith({
  target,
  children,
}: {
  target: string;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const label = t("agentOutput.openWith", { defaultValue: "打开方式" });
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="wb-output-open-with"
          title={label}
          aria-label={`${label}：${target}`}
        >
          <ChevronDown size={13} aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">{children}</DropdownMenuContent>
    </DropdownMenu>
  );
}
