import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { GitBranch } from "lucide-react";
import { DevelopmentFrontendRefreshButton } from "./DevelopmentFrontendRefreshButton";
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
  compact = false,
  showRefresh = true,
}: {
  developmentOnly?: boolean;
  compact?: boolean;
  showRefresh?: boolean;
}) {
  const { i18n, t } = useTranslation();
  if (developmentOnly && !IS_DEVELOPMENT_BUILD) return null;
  const label = buildChannelLabel(i18n.language);
  const buildLabel =
    IS_DEVELOPMENT_BUILD && BUILD_NUMBER ? `${label} · ${BUILD_NUMBER}` : label;
  const branchLabel = t("buildChannel.buildBranch", {
    defaultValue: "构建分支：",
  });
  const branchTitle = `${branchLabel}${BUILD_BRANCH}${BUILD_DIRTY ? " · " + t("buildChannel.dirty", { defaultValue: "含未提交改动" }) : ""}`;
  const buildTitle =
    IS_DEVELOPMENT_BUILD && BUILD_REVISION
      ? `${buildLabel} · ${BUILD_REVISION}`
      : buildLabel;
  const badge = (
    <Badge
      variant="secondary"
      className={
        IS_DEVELOPMENT_BUILD
          ? "min-w-0 max-w-[15rem] bg-warning-soft text-warning-text"
          : "shrink-0"
      }
      title={
        compact && IS_DEVELOPMENT_BUILD && BUILD_BRANCH
          ? `${buildTitle} · ${branchTitle}`
          : buildTitle
      }
      data-build-channel={IS_DEVELOPMENT_BUILD ? "development" : "stable"}
    >
      <span className="truncate">{compact ? label : buildLabel}</span>
    </Badge>
  );
  if (!IS_DEVELOPMENT_BUILD) return badge;
  if (compact)
    return (
      <div className="tai-build-channel-compact inline-flex shrink-0 items-center gap-1">
        {badge}
        {showRefresh && <DevelopmentFrontendRefreshButton iconOnly />}
      </div>
    );
  return (
    <div className="inline-flex min-w-0 max-w-[18rem] flex-col items-start gap-0.5">
      {badge}
      <div className="inline-flex max-w-full items-center gap-1.5">
        {BUILD_BRANCH && (
          <span
            className="inline-flex max-w-full items-center gap-1 text-[11px] leading-3 text-fg-2"
            title={branchTitle}
          >
            <GitBranch className="h-3 w-3 shrink-0" aria-hidden="true" />
            <span className="truncate font-mono">{BUILD_BRANCH}</span>
            {BUILD_DIRTY && <span aria-hidden="true">*</span>}
          </span>
        )}
        {showRefresh && <DevelopmentFrontendRefreshButton />}
      </div>
    </div>
  );
}
