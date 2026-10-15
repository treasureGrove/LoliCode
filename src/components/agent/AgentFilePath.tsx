import { createContext, useContext, useState, type ReactNode } from "react";
import { ExternalLink, FolderOpen, PanelRightOpen } from "lucide-react";
import { agentFilesApi } from "@/lib/api/agent-files";
import { shortenPath } from "@/components/sessions/reader/PathChip";

export const AgentFileActionsContext = createContext<{
  sessionId?: string;
  projectPath?: string;
  onPreview: (path: string) => void;
} | null>(null);

export function AgentFilePath({
  path,
  label,
}: {
  path: string;
  label?: ReactNode;
}) {
  const actions = useContext(AgentFileActionsContext);
  const [error, setError] = useState<string | null>(null);
  if (!actions?.sessionId) return <span title={path}>{label || path}</span>;
  const open = async (action: "file" | "directory") => {
    setError(null);
    try {
      await agentFilesApi.open(actions.sessionId!, path, action);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
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
          actions.onPreview(path);
        }}
      >
        {label || shortenPath(path, actions.projectPath)}
      </button>
      <span className="wb-file-path-actions">
        <button
          type="button"
          aria-label={`打开文件：${path}`}
          title="打开文件"
          onClick={(event) => {
            event.preventDefault();
            void open("file");
          }}
        >
          <ExternalLink size={12} />
        </button>
        <button
          type="button"
          aria-label={`打开所在文件夹：${path}`}
          title="打开所在文件夹"
          onClick={(event) => {
            event.preventDefault();
            void open("directory");
          }}
        >
          <FolderOpen size={12} />
        </button>
        <button
          type="button"
          aria-label={`在侧栏预览：${path}`}
          title="在侧栏预览"
          onClick={(event) => {
            event.preventDefault();
            actions.onPreview(path);
          }}
        >
          <PanelRightOpen size={12} />
        </button>
      </span>
      {error && (
        <span role="alert" className="text-danger-text">
          {error}
        </span>
      )}
    </span>
  );
}
