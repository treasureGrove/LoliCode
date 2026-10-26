import { useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  Loader2,
  LogIn,
  LogOut,
  RefreshCw,
  Settings,
  Smartphone,
  UserRound,
} from "lucide-react";
import { APP_NAME } from "@/lib/branding";
import { useLolicodeAccount } from "@/hooks/useLolicodeAccount";
import type { LolicodeAccount } from "@/lib/api/lolicode-account";
import { settingsApi } from "@/lib/api/settings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import "./sidebar-profile-menu.css";
import { LolicodeRelayDialog } from "./LolicodeRelayDialog";
import { MobileCompanionDialog } from "./MobileCompanionDialog";

export interface SidebarProfileMenuProps {
  onOpenSettings: () => void;
  onOpenUpdates: () => void;
  hasUpdate?: boolean;
  selected?: boolean;
}

function AccountAvatar({ account }: { account: LolicodeAccount | null }) {
  const [failed, setFailed] = useState(false);
  return (
    <span className="tai-shell-profile-picture" aria-hidden="true">
      {account?.avatarUrl && !failed ? (
        <img
          className="tai-shell-profile-avatar"
          src={account.avatarUrl}
          alt=""
          referrerPolicy="no-referrer"
          draggable={false}
          onError={() => setFailed(true)}
        />
      ) : account ? (
        <span>
          {Array.from(
            account.displayName || account.username,
          )[0]?.toLocaleUpperCase()}
        </span>
      ) : (
        <UserRound size={18} />
      )}
    </span>
  );
}

/** One forum identity also unlocks the sponsored model allowance. */
export function SidebarProfileMenu({
  onOpenSettings,
  onOpenUpdates,
  hasUpdate = false,
  selected = false,
}: SidebarProfileMenuProps) {
  const { t, i18n } = useTranslation();
  const chinese = i18n.language.startsWith("zh");
  const text = (zh: string, en: string) => (chinese ? zh : en);
  const identity = useLolicodeAccount();
  const { account } = identity;
  const [loginOpen, setLoginOpen] = useState(false);
  const [relayOpen, setRelayOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [identification, setIdentification] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const identityId = useId();
  const identificationId = useId();
  const passwordId = useId();
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

  const avatarKey = `${account?.id ?? "anonymous"}:${account?.avatarUrl ?? ""}`;
  const identityLabel = account
    ? `${account.displayName} · @${account.username}`
    : identity.isLoading
      ? text("正在读取 LoliCode 账户…", "Loading LoliCode account…")
      : text("尚未登录 LoliCode", "Not signed in to LoliCode");
  const changeLoginOpen = (open: boolean) => {
    if (identity.isPending) return;
    setLoginOpen(open);
    setPassword("");
    setShowPassword(false);
    setActionError(null);
    if (!open) setIdentification("");
  };
  const perform = async (operation: () => Promise<unknown>) => {
    setActionError(null);
    try {
      await operation();
    } catch {
      setActionError(
        text(
          "账户操作失败，请检查网络后重试。",
          "Account action failed. Check your connection and try again.",
        ),
      );
    }
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            ref={triggerRef}
            className="tai-shell-profile"
            aria-label={profileLabel}
            aria-describedby={hasUpdate ? updateNoticeId : identityId}
            data-selected={selected}
            title={account ? `${account.displayName} · LoliCode` : profileLabel}
          >
            <AccountAvatar key={avatarKey} account={account} />
            <span id={identityId} className="sr-only">
              {identityLabel}
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
        <DropdownMenuContent
          className="tai-shell-account-menu"
          side="right"
          align="end"
          sideOffset={10}
          onCloseAutoFocus={(event) => {
            if (loginOpen) event.preventDefault();
          }}
        >
          <DropdownMenuLabel className="tai-shell-account-summary">
            <AccountAvatar key={avatarKey} account={account} />
            <span>
              <strong>{account?.displayName || APP_NAME}</strong>
              <small>{account ? `@${account.username}` : identityLabel}</small>
            </span>
          </DropdownMenuLabel>
          {(identity.warning || actionError || identity.error) && (
            <p className="tai-shell-account-notice" role="status">
              {actionError ||
                identity.warning ||
                text(
                  "暂时无法读取账户，请重试。",
                  "Unable to load your account. Please retry.",
                )}
            </p>
          )}
          {account ? (
            <>
              <DropdownMenuItem onSelect={() => setRelayOpen(true)}>
                {text(
                  "公益模型与每日额度",
                  "Sponsored models and daily allowance",
                )}
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() =>
                  void perform(() =>
                    settingsApi.openExternal(account.profileUrl),
                  )
                }
              >
                <ExternalLink size={15} aria-hidden="true" />
                {text("个人主页", "Your profile")}
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={identity.isPending || identity.isRefreshing}
                onSelect={(event) => {
                  event.preventDefault();
                  void perform(identity.refresh);
                }}
              >
                <RefreshCw
                  size={15}
                  className={identity.isRefreshing ? "animate-spin" : undefined}
                  aria-hidden="true"
                />
                {text("刷新账户资料", "Refresh account")}
              </DropdownMenuItem>
            </>
          ) : (
            <DropdownMenuItem
              disabled={identity.isLoading || identity.isPending}
              onSelect={() => changeLoginOpen(true)}
            >
              <LogIn size={15} aria-hidden="true" />
              {text("登录 LoliCode", "Sign in to LoliCode")}
            </DropdownMenuItem>
          )}
          {!account && identity.error && (
            <DropdownMenuItem
              disabled={identity.isRefreshing}
              onSelect={(event) => {
                event.preventDefault();
                void perform(identity.refresh);
              }}
            >
              <RefreshCw size={15} aria-hidden="true" />
              {text("重新读取账户", "Retry loading account")}
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setMobileOpen(true)}>
            <Smartphone size={15} aria-hidden="true" />
            {text("连接手机", "Connect a phone")}
          </DropdownMenuItem>
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
          {account && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                disabled={identity.isPending}
                onSelect={(event) => {
                  event.preventDefault();
                  void perform(identity.logout);
                }}
              >
                <LogOut size={15} aria-hidden="true" />
                {text("退出 LoliCode 登录", "Sign out of LoliCode")}
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <MobileCompanionDialog
        open={mobileOpen}
        onOpenChange={setMobileOpen}
        accountId={account?.id ?? null}
        onRequestLogin={() => {
          setMobileOpen(false);
          changeLoginOpen(true);
        }}
      />
      <Dialog open={loginOpen} onOpenChange={changeLoginOpen}>
        <DialogContent
          className="tai-shell-account-dialog"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            triggerRef.current?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {text("登录 LoliCode", "Sign in to LoliCode")}
            </DialogTitle>
            <DialogDescription>
              {text(
                "使用原有 lolicode.com 账号登录，公益模型共用这个账号，无需再次注册。",
                "Sign in with your existing lolicode.com account. Sponsored models use the same account.",
              )}
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={async (event) => {
              event.preventDefault();
              if (identity.isPending || !identification.trim() || !password)
                return;
              setActionError(null);
              try {
                await identity.login(identification.trim(), password);
                setLoginOpen(false);
                setIdentification("");
                setPassword("");
                setShowPassword(false);
              } catch {
                setActionError(
                  text(
                    "登录失败，请检查用户名、密码和网络连接后重试。",
                    "Sign-in failed. Check your username, password, and connection, then try again.",
                  ),
                );
              }
            }}
          >
            <div className="tai-shell-account-fields">
              <label htmlFor={identificationId}>
                {text("用户名或邮箱", "Username or email")}
              </label>
              <Input
                id={identificationId}
                name="username"
                autoComplete="username"
                required
                maxLength={254}
                disabled={identity.isPending}
                value={identification}
                onChange={(event) => setIdentification(event.target.value)}
              />
              <label htmlFor={passwordId}>{text("密码", "Password")}</label>
              <div className="tai-shell-account-password">
                <Input
                  id={passwordId}
                  name="password"
                  type={showPassword ? "text" : "password"}
                  autoComplete="current-password"
                  required
                  disabled={identity.isPending}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  disabled={identity.isPending}
                  aria-label={
                    showPassword
                      ? text("隐藏密码", "Hide password")
                      : text("显示密码", "Show password")
                  }
                  aria-pressed={showPassword}
                  onClick={() => setShowPassword(!showPassword)}
                >
                  {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </Button>
              </div>
              {actionError && (
                <p className="tai-shell-account-error" role="alert">
                  {actionError}
                </p>
              )}
              <p className="tai-shell-account-hint">
                {text(
                  "密码不会保存，登录凭据优先存入系统凭据库。",
                  "Your password is never saved. The sign-in token is kept in the system credential store when available.",
                )}
              </p>
              <Button
                className="tai-shell-account-website"
                type="button"
                variant="link"
                onClick={() =>
                  void perform(() =>
                    settingsApi.openExternal("https://lolicode.com"),
                  )
                }
              >
                {text("注册或找回密码 ↗", "Register or recover password ↗")}
              </Button>
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={identity.isPending}
                onClick={() => changeLoginOpen(false)}
              >
                {text("取消", "Cancel")}
              </Button>
              <Button
                type="submit"
                disabled={
                  identity.isPending || !identification.trim() || !password
                }
              >
                {identity.isPending && (
                  <Loader2
                    size={15}
                    className="animate-spin"
                    aria-hidden="true"
                  />
                )}
                {identity.isPending
                  ? text("正在登录…", "Signing in…")
                  : text("登录", "Sign in")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <LolicodeRelayDialog
        open={relayOpen}
        onOpenChange={setRelayOpen}
        accountId={account?.id ?? null}
      />
    </>
  );
}
