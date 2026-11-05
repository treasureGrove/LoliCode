import { useContext, type ReactNode } from "react";
import { Copy, ExternalLink, PanelRightOpen } from "lucide-react";
import { useTranslation } from "react-i18next";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { copyText } from "@/lib/clipboard";
import { settingsApi } from "@/lib/api/settings";
import { toast } from "@/lib/toast";
import { agentErrorMessage } from "@/hooks/useAgentSnapshot";
import { AgentFileActionsContext } from "./AgentFilePath";
import { AgentOpenWith } from "./AgentOpenWith";

export function AgentWebLink({
  url,
  label,
}: {
  url: string;
  label: ReactNode;
}) {
  const { t } = useTranslation();
  const openInSidebar = useContext(AgentFileActionsContext)?.onOpenWeb;
  const openExternal = () => {
    void settingsApi.openExternal(url).catch((cause) => {
      toast.error(agentErrorMessage(cause));
    });
  };
  return (
    <span className="wb-output-link">
      <a
        href={url}
        title={url}
        rel="noopener noreferrer"
        onClick={(event) => {
          event.preventDefault();
          if (openInSidebar && !event.ctrlKey && !event.metaKey)
            openInSidebar(url);
          else openExternal();
        }}
        onAuxClick={(event) => {
          event.preventDefault();
          if (event.button === 1) openExternal();
        }}
      >
        {label}
      </a>
      <AgentOpenWith target={url}>
        {openInSidebar && (
          <DropdownMenuItem onSelect={() => openInSidebar(url)}>
            <PanelRightOpen size={14} aria-hidden="true" />
            {t("agentOutput.openSidebar", { defaultValue: "在右栏打开" })}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onSelect={openExternal}>
          <ExternalLink size={14} aria-hidden="true" />
          {t("agentOutput.openBrowser", { defaultValue: "在系统浏览器中打开" })}
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => {
            void copyText(url).catch((cause) => {
              toast.error(agentErrorMessage(cause));
            });
          }}
        >
          <Copy size={14} aria-hidden="true" />
          {t("agentOutput.copyLink", { defaultValue: "复制链接" })}
        </DropdownMenuItem>
      </AgentOpenWith>
    </span>
  );
}
