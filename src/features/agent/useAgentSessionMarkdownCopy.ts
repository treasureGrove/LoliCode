import { useSyncExternalStore } from "react";
import { toast } from "sonner";
import { agentApi } from "@/lib/api/agent";
import { copyText } from "@/lib/clipboard";
import { agentErrorMessage } from "@/hooks/useAgentSnapshot";

// The clipboard belongs to the window, not the selected conversation. Keep the
// first clicked session while its complete native log is being prepared.
let pending: Promise<void> | null = null;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const snapshot = () => pending !== null;
const notify = () => {
  for (const listener of listeners) listener();
};

export function copyAgentSessionMarkdown(sessionId: string): Promise<void> {
  if (pending) return pending;
  pending = Promise.resolve()
    .then(async () => {
      let markdown: string;
      try {
        markdown = await agentApi.readSessionMarkdown(sessionId);
      } catch (cause) {
        toast.error(`读取会话失败：${agentErrorMessage(cause)}`);
        return;
      }
      try {
        await copyText(markdown);
        toast.success("会话已复制为 Markdown");
      } catch {
        toast.error("复制失败，请检查剪贴板权限。");
      }
    })
    .finally(() => {
      pending = null;
      notify();
    });
  notify();
  return pending;
}

export function useAgentSessionMarkdownCopy() {
  const copying = useSyncExternalStore(subscribe, snapshot, snapshot);
  return { copying, copy: copyAgentSessionMarkdown };
}
