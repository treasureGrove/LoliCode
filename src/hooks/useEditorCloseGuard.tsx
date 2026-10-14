import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { discardUnsavedChanges, hasUnsavedChanges } from "@/lib/unsavedChanges";

/** A close request never unmounts the editor until the user discards its draft. */
export function useEditorCloseGuard(open: boolean, busy: boolean) {
  const { t } = useTranslation();
  const [pending, setPending] = useState<(() => void) | null>(null);
  useEffect(() => {
    if (!open) setPending(null);
  }, [open]);

  const requestLeave = useCallback(
    (proceed: () => void) => {
      if (busy) return;
      if (hasUnsavedChanges()) setPending(() => proceed);
      else proceed();
    },
    [busy],
  );

  const leaveDialog = pending ? (
    <ConfirmDialog
      isOpen
      title={t("common.unsavedLeaveTitle")}
      message={t("common.unsavedLeaveMessage")}
      confirmText={t("common.unsavedLeaveConfirm")}
      cancelText={t("common.unsavedLeaveCancel")}
      zIndex="top"
      onConfirm={() => {
        setPending(null);
        discardUnsavedChanges();
        pending();
      }}
      onCancel={() => setPending(null)}
    />
  ) : null;
  return { requestLeave, leaveDialog };
}
