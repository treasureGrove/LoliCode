import { useSyncExternalStore, type CSSProperties } from "react";
import { RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { IS_DEVELOPMENT_BUILD } from "@/lib/buildChannel";
import {
  isDevelopmentFrontendRebuilding,
  rebuildDevelopmentFrontend,
  subscribeDevelopmentFrontend,
} from "@/lib/developmentFrontend";
import { toast } from "@/lib/toast";
import { extractErrorMessage } from "@/utils/errorUtils";

export function DevelopmentFrontendRefreshButton() {
  const { t } = useTranslation();
  const busy = useSyncExternalStore(
    subscribeDevelopmentFrontend,
    isDevelopmentFrontendRebuilding,
    isDevelopmentFrontendRebuilding,
  );
  if (!IS_DEVELOPMENT_BUILD) return null;
  const refresh = async () => {
    try {
      await rebuildDevelopmentFrontend(() =>
        window.confirm(
          t("buildChannel.confirmFrontendReload", {
            defaultValue:
              "新界面已构建完成。当前有未保存的修改，刷新会丢弃这些修改。是否继续刷新？",
          }),
        ),
      );
    } catch (error) {
      toast.error(
        t("buildChannel.frontendReloadFailed", {
          defaultValue: "界面热更新失败：{{error}}",
          error: extractErrorMessage(error),
        }),
      );
    }
  };
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="h-5 gap-1 px-1 text-[11px]"
      style={{ WebkitAppRegion: "no-drag" } as CSSProperties}
      disabled={busy}
      onClick={() => void refresh()}
      title={t("buildChannel.frontendReloadHelp", {
        defaultValue:
          "构建最新界面并刷新窗口；后台任务继续运行。后端改动仍需完整重建。",
      })}
    >
      <RefreshCw
        className={`h-3 w-3${busy ? " animate-spin" : ""}`}
        aria-hidden="true"
      />
      {busy
        ? t("buildChannel.frontendBuilding", { defaultValue: "构建界面中…" })
        : t("buildChannel.refreshFrontend", { defaultValue: "热更新界面" })}
    </Button>
  );
}
