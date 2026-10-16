import { useId } from "react";
import { useTranslation } from "react-i18next";
import { Download, Settings } from "lucide-react";
import companion from "@/assets/atelier/companion.png";
import { APP_NAME } from "@/lib/branding";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import "./sidebar-profile-menu.css";

export interface SidebarProfileMenuProps {
  onOpenSettings: () => void;
  onOpenUpdates: () => void;
  hasUpdate?: boolean;
  selected?: boolean;
}

/** The local companion opens application preferences without implying an account. */
export function SidebarProfileMenu({
  onOpenSettings,
  onOpenUpdates,
  hasUpdate = false,
  selected = false,
}: SidebarProfileMenuProps) {
  const { t, i18n } = useTranslation();
  const chinese = i18n.language.startsWith("zh");
  const updateNoticeId = useId();
  const profileLabel = t("nav.profileMenu", {
    defaultValue: chinese ? "头像与设置" : "Profile and settings",
  });
  const settingsLabel = t("nav.settings", {
    defaultValue: chinese ? "设置" : "Settings",
  });
  const updatesLabel = t("nav.softwareUpdates", {
    defaultValue: chinese ? "软件更新" : "Software updates",
  });
  const updateHint = t("nav.softwareUpdatesAvailable", {
    defaultValue: chinese
      ? "发现 LoliCode 新版本"
      : "A new LoliCode version is available",
  });

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="tai-shell-profile"
          aria-label={profileLabel}
          aria-describedby={hasUpdate ? updateNoticeId : undefined}
          data-selected={selected}
          title={profileLabel}
        >
          <span className="tai-shell-profile-picture" aria-hidden="true">
            <img
              className="tai-shell-profile-avatar"
              src={companion}
              alt=""
              draggable={false}
            />
          </span>
          {hasUpdate && (
            <>
              <span className="tai-shell-profile-notice" aria-hidden="true" />
              <span id={updateNoticeId} className="sr-only">
                {updateHint}
              </span>
            </>
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="right" align="end" sideOffset={10}>
        <DropdownMenuLabel>{APP_NAME}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onOpenSettings}>
          <Settings size={15} aria-hidden="true" />
          {settingsLabel}
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={onOpenUpdates}
          aria-label={
            hasUpdate ? `${updatesLabel} · ${updateHint}` : updatesLabel
          }
        >
          <Download size={15} aria-hidden="true" />
          {updatesLabel}
          {hasUpdate && <span className="sr-only">{updateHint}</span>}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
