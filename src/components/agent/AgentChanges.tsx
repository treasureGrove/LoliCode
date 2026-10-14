import { FileDiff } from "lucide-react";
import type { AgentDiff } from "@/types/agent";
import { SessionDiff } from "@/components/sessions/reader/SessionDiff";

/** Display only authoritative diffs returned by the running engine. */
export function AgentChanges({ diffs }: { diffs: AgentDiff[] }) {
  if (!diffs.length) return null;
  return (
    <details className="wb-changes shrink-0">
      <summary className="flex cursor-pointer items-center gap-2 px-5 py-3 text-body font-medium">
        <FileDiff className="h-4 w-4" />
        文件修改 · {diffs.length} 个文件
        <span className="ml-auto text-caption">
          <span className="text-success-text">
            +{diffs.reduce((sum, diff) => sum + diff.additions, 0)}
          </span>{" "}
          <span className="text-danger-text">
            −{diffs.reduce((sum, diff) => sum + diff.deletions, 0)}
          </span>
        </span>
      </summary>
      <div className="max-h-80 space-y-2 overflow-auto px-5 pb-4">
        {diffs.map((diff) => (
          <details
            key={diff.path}
            className="rounded-control border border-border"
          >
            <summary className="cursor-pointer break-all px-3 py-2 text-caption">
              {diff.path}{" "}
              <span className="text-fg-3">
                {diff.status === "added"
                  ? "新增"
                  : diff.status === "deleted"
                    ? "删除"
                    : "修改"}
              </span>
            </summary>
            <div className="px-3 pb-3">
              <SessionDiff text={diff.patch} />
            </div>
          </details>
        ))}
      </div>
    </details>
  );
}
