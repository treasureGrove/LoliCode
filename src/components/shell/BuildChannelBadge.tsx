import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import {
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
  const { i18n } = useTranslation();
  if (developmentOnly && !IS_DEVELOPMENT_BUILD) return null;
  const label = buildChannelLabel(i18n.language);
  const buildLabel =
    IS_DEVELOPMENT_BUILD && BUILD_NUMBER ? `${label} · ${BUILD_NUMBER}` : label;
  return (
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
}
