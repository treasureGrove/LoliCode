import { createContext, useContext, useState, type ReactNode } from "react";
import { Copy, ExternalLink, FolderOpen, PanelRightOpen } from "lucide-react";
import { useTranslation } from "react-i18next";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { agentFilesApi } from "@/lib/api/agent-files";
import { copyText } from "@/lib/clipboard";
import { shortenPath } from "@/features/sessions/reader/PathChip";
import { splitDocumentPath } from "./AgentDocumentViewer";
import { AgentOpenWith } from "./AgentOpenWith";

export const AgentFileActionsContext = createContext<{
  sessionId?: string;
  projectPath?: string;
  remote?: boolean;
  onPreview: (path: string, line?: number) => void;
  onOpenWeb?: (url: string) => void;
} | null>(null);

export function AgentFilePath({
  path,
  label,
  line,
}: {
  path: string;
  label?: ReactNode;
  line?: number;
}) {
  const { t } = useTranslation();
  const actions = useContext(AgentFileActionsContext);
  const [error, setError] = useState<string | null>(null);
  const sessionId = actions?.sessionId;
  if (!sessionId) return <span title={path}>{label || path}</span>;
  const filePath = splitDocumentPath(path).filePath;
  const run = async (action: () => Promise<void>) => {
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const preview = () => {
    setError(null);
    if (line === undefined) actions.onPreview(path);
    else actions.onPreview(path, line);
  };
  return (
    <span className="wb-file-path" onClick={(event) => event.stopPropagation()}>
      <button
        type="button"
        title={path}
        aria-label={`预览文件：${path}`}
        className="wb-file-path-label"
        onClick={(event) => {
          event.preventDefault();
          preview();
        }}
      >
        {label || shortenPath(path, actions.projectPath)}
      </button>
      <AgentOpenWith target={path}>
        <DropdownMenuItem onSelect={preview}>
          <PanelRightOpen size={14} aria-hidden="true" />
          {t("agentOutput.openSidebar", { defaultValue: "在右栏打开" })}
        </DropdownMenuItem>
        {!actions.remote && (
          <>
            <DropdownMenuItem
              onSelect={() =>
                void run(() => agentFilesApi.open(sessionId, filePath, "file"))
              }
            >
              <ExternalLink size={14} aria-hidden="true" />
              {t("agentOutput.openFile", { defaultValue: "在系统应用中打开" })}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() =>
                void run(() =>
                  agentFilesApi.open(sessionId, filePath, "directory"),
                )
              }
            >
              <FolderOpen size={14} aria-hidden="true" />
              {t("agentOutput.openFolder", { defaultValue: "打开所在文件夹" })}
            </DropdownMenuItem>
          </>
        )}
        <DropdownMenuItem onSelect={() => void run(() => copyText(filePath))}>
          <Copy size={14} aria-hidden="true" />
          {t("agentOutput.copyPath", { defaultValue: "复制路径" })}
        </DropdownMenuItem>
      </AgentOpenWith>
      {error && (
        <span role="alert" className="text-danger-text">
          {error}
        </span>
      )}
    </span>
  );
}
