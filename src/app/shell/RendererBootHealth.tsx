import { useEffect } from "react";
import {
  rendererUpdatesApi,
  rendererStatusKey,
} from "@/lib/api/renderer-updates";
import { queryClient } from "@/lib/query";
import { reportFrontendError } from "@/lib/frontendLogger";

/** Mount inside the normal application boundary, never the recovery screens.
 * A module merely downloading is not a health receipt. If React fails during
 * initial render the component unmounts and leaves rollback armed for next boot.
 */
export function RendererBootHealth() {
  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        const status = await rendererUpdatesApi.local();
        if (cancelled) return;
        if (
          status.runningId &&
          status.bootTicket &&
          status.state.pendingConfirmation
        ) {
          await rendererUpdatesApi.confirm(status.runningId, status.bootTicket);
          if (cancelled) return;
          queryClient.setQueryData(
            rendererStatusKey,
            await rendererUpdatesApi.local(),
          );
        }
      })().catch((error) => reportFrontendError("renderer_boot_health", error));
    }, 1500);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, []);
  return null;
}
