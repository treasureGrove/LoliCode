import {
  ChevronDown,
  ChevronRight,
  File,
  Folder,
  RefreshCw,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import {
  agentFilesApi,
  type AgentWorkspaceDirectory,
} from "@/lib/api/agent-files";
import "./agent-workspace-panels.css";

type FilePanelProps = {
  sessionId: string;
  projectPath: string;
  visible: boolean;
  onOpenFile: (path: string) => void;
  onClose: () => void;
};

const names = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

function DirectoryEntries({
  sessionId,
  path,
  visible,
  depth,
  revision,
  onOpenFile,
}: Pick<FilePanelProps, "sessionId" | "visible" | "onOpenFile"> & {
  path: string;
  depth: number;
  revision: number;
}) {
  const [directory, setDirectory] = useState<AgentWorkspaceDirectory>();
  const [error, setError] = useState<string>();
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    if (!visible) return;
    let active = true;
    let pending = false;
    const refresh = () => {
      if (pending) return;
      pending = true;
      void agentFilesApi
        .listDirectory(sessionId, path)
        .then(
          (result) => {
            if (!active) return;
            result.entries.sort(
              (a, b) =>
                Number(b.kind === "directory") -
                  Number(a.kind === "directory") ||
                names.compare(a.name, b.name),
            );
            setDirectory((previous) =>
              previous && JSON.stringify(previous) === JSON.stringify(result)
                ? previous
                : result,
            );
            setError(undefined);
          },
          (reason: unknown) => {
            if (active) setError(String(reason));
          },
        )
        .finally(() => {
          pending = false;
        });
    };
    refresh();
    const timer = depth === 0 ? window.setInterval(refresh, 8_000) : undefined;
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [sessionId, path, revision, visible, depth]);

  if (error)
    return (
      <div className="agent-workspace-note" role="alert">
        {error}
      </div>
    );
  if (!directory)
    return <div className="agent-workspace-note">正在读取目录…</div>;
  if (!directory.entries.length)
    return <div className="agent-workspace-note">空目录</div>;

  return (
    <ul className="agent-workspace-tree">
      {directory.entries.map((entry) => {
        const folder = entry.kind === "directory";
        const open = expanded.has(entry.path);
        return (
          <li key={entry.path}>
            <button
              type="button"
              title={entry.path}
              className="agent-workspace-entry"
              style={{ paddingInlineStart: 8 + depth * 14 }}
              aria-expanded={folder ? open : undefined}
              disabled={entry.kind === "other"}
              onClick={() => {
                if (!folder) {
                  onOpenFile(entry.path);
                  return;
                }
                setExpanded((current) => {
                  const next = new Set(current);
                  if (next.has(entry.path)) next.delete(entry.path);
                  else next.add(entry.path);
                  return next;
                });
              }}
            >
              {folder &&
                (open ? <ChevronDown size={14} /> : <ChevronRight size={14} />)}
              {folder ? <Folder size={15} /> : <File size={15} />}
              <span>{entry.name}</span>
            </button>
            {folder && open && (
              <DirectoryEntries
                sessionId={sessionId}
                path={entry.path}
                visible={visible}
                depth={depth + 1}
                revision={revision}
                onOpenFile={onOpenFile}
              />
            )}
          </li>
        );
      })}
      {directory.truncated && (
        <li className="agent-workspace-note">目录过大，仅显示部分条目</li>
      )}
    </ul>
  );
}

export function AgentProjectFilesPanel({
  sessionId,
  projectPath,
  visible,
  onOpenFile,
  onClose,
}: FilePanelProps) {
  const [revision, setRevision] = useState(0);
  return (
    <section className="agent-workspace-panel" aria-label="项目目录">
      <header className="agent-workspace-toolbar">
        <span title={projectPath}>项目目录</span>
        <button
          type="button"
          title="刷新目录"
          aria-label="刷新目录"
          onClick={() => setRevision((value) => value + 1)}
        >
          <RefreshCw size={15} />
        </button>
        <button
          type="button"
          title="关闭项目目录"
          aria-label="关闭项目目录"
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </header>
      <div className="agent-workspace-tree-scroll">
        <DirectoryEntries
          key={`${sessionId}:${projectPath}`}
          sessionId={sessionId}
          path="."
          visible={visible}
          depth={0}
          revision={revision}
          onOpenFile={onOpenFile}
        />
      </div>
    </section>
  );
}
