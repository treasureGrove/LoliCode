import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { GitBranch } from "lucide-react";
import {
  BUILD_BRANCH,
  BUILD_DIRTY,
  BUILD_NUMBER,
  BUILD_REVISION,
  IS_DEVELOPMENT_BUILD,
  buildChannelLabel,
} from "@/lib/buildChannel";

export function BuildChannelBadge({
  developmentOnly = false,
}: {
  developmentOnly?: boolean;
}) {
  const { i18n, t } = useTranslation();
  if (developmentOnly && !IS_DEVELOPMENT_BUILD) return null;
  const label = buildChannelLabel(i18n.language);
  const buildLabel =
    IS_DEVELOPMENT_BUILD && BUILD_NUMBER ? `${label} · ${BUILD_NUMBER}` : label;
  const badge = (
    <Badge
      variant="secondary"
      className={
        IS_DEVELOPMENT_BUILD
          ? "min-w-0 max-w-[15rem] bg-warning-soft text-warning-text"
          : "shrink-0"
      }
      title={
        IS_DEVELOPMENT_BUILD && BUILD_REVISION
          ? `${buildLabel} · ${BUILD_REVISION}`
          : buildLabel
      }
      data-build-channel={IS_DEVELOPMENT_BUILD ? "development" : "stable"}
    >
      <span className="truncate">{buildLabel}</span>
    </Badge>
  );
  if (!IS_DEVELOPMENT_BUILD || !BUILD_BRANCH) return badge;
  const branchLabel = t("buildChannel.buildBranch", {
    defaultValue: "构建分支：",
  });
  return (
    <div className="inline-flex min-w-0 max-w-[18rem] flex-col items-start gap-0.5">
      {badge}
      <span
        className="inline-flex max-w-full items-center gap-1 text-[11px] leading-3 text-fg-2"
        title={`${branchLabel}${BUILD_BRANCH}${BUILD_DIRTY ? " · " + t("buildChannel.dirty", { defaultValue: "含未提交改动" }) : ""}`}
      >
        <GitBranch className="h-3 w-3 shrink-0" aria-hidden="true" />
        <span className="truncate font-mono">{BUILD_BRANCH}</span>
        {BUILD_DIRTY && <span aria-hidden="true">*</span>}
      </span>
    </div>
  );
}
