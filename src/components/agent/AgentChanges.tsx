import { useRef } from "react";
import { ChevronRight, FileDiff } from "lucide-react";
import type { AgentDiff } from "@/types/agent";
import { SessionDiff } from "@/components/sessions/reader/SessionDiff";
import { AgentFilePath } from "./AgentFilePath";
import {
  AgentDisclosure,
  createAgentDisclosureState,
  type AgentDisclosureState,
} from "./AgentDisclosure";

/** Display only authoritative diffs returned by the running engine. */
export function AgentChanges({ diffs }: { diffs: AgentDiff[] }) {
  const files = useRef(new Map<string, AgentDisclosureState>());
  if (!diffs.length) return null;
  return (
    <AgentDisclosure
      className="wb-changes wb-disclosure shrink-0"
      summaryClassName="flex cursor-pointer items-center gap-2 px-5 py-3 text-body font-medium"
      bodyClassName="wb-change-list"
      summary={
        <>
          <ChevronRight
            className="wb-disclosure-chevron h-3.5 w-3.5 shrink-0"
            aria-hidden="true"
          />
          <FileDiff className="h-4 w-4 shrink-0" aria-hidden="true" />
          文件修改 · {diffs.length} 个文件
          <span className="ml-auto text-caption">
            <span className="text-success-text">
              +{diffs.reduce((sum, diff) => sum + diff.additions, 0)}
            </span>{" "}
            <span className="text-danger-text">
              −{diffs.reduce((sum, diff) => sum + diff.deletions, 0)}
            </span>
          </span>
        </>
      }
    >
      {() =>
        diffs.map((diff) => {
          let state = files.current.get(diff.path);
          if (!state) {
            state = createAgentDisclosureState();
            files.current.set(diff.path, state);
          }
          return (
            <AgentDisclosure
              key={diff.path}
              state={state}
              className="wb-change-file wb-disclosure"
              summaryClassName="flex cursor-pointer items-center gap-2 px-3 py-2 text-caption"
              bodyClassName="px-3 pb-3"
              summary={
                <>
                  <ChevronRight
                    className="wb-disclosure-chevron h-3.5 w-3.5 shrink-0"
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1 truncate">
                    <AgentFilePath path={diff.path} />
                  </span>
                  <span className="shrink-0 text-fg-3">
                    {diff.status === "added"
                      ? "新增"
                      : diff.status === "deleted"
                        ? "删除"
                        : "修改"}
                  </span>
                  <span
                    className="shrink-0"
                    aria-label={`新增 ${diff.additions} 行，删除 ${diff.deletions} 行`}
                  >
                    <span className="text-success-text">+{diff.additions}</span>{" "}
                    <span className="text-danger-text">−{diff.deletions}</span>
                  </span>
                </>
              }
            >
              {() => <SessionDiff className="wb-code-diff" text={diff.patch} />}
            </AgentDisclosure>
          );
        })
      }
    </AgentDisclosure>
  );
}
