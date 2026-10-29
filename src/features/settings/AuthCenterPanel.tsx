import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { CopilotAuthSection } from "@/features/providers/forms/CopilotAuthSection";
import { CodexOAuthSection } from "@/features/providers/forms/CodexOAuthSection";
import { XaiOAuthSection } from "@/features/providers/forms/XaiOAuthSection";
import type { ManagedAuthProvider } from "@/lib/api";

interface AuthCenterPanelProps {
  authScrollTarget?: ManagedAuthProvider | null;
  /**
   * 嵌入渠道页的账号管理弹窗时可隐藏重复说明。
   */
  showIntro?: boolean;
}

/**
 * 渠道内的账号维护：复用 GitHub Copilot、ChatGPT、xAI 三组原有管理组件。
 */
export function AuthCenterPanel({
  authScrollTarget,
  showIntro = true,
}: AuthCenterPanelProps) {
  const { t } = useTranslation();
  const copilotSectionRef = useRef<HTMLDivElement | null>(null);
  const codexOauthSectionRef = useRef<HTMLDivElement | null>(null);
  const xaiOauthSectionRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!authScrollTarget) return;

    const sectionRef =
      authScrollTarget === "github_copilot"
        ? copilotSectionRef
        : authScrollTarget === "codex_oauth"
          ? codexOauthSectionRef
          : xaiOauthSectionRef;

    const frame = requestAnimationFrame(() => {
      const prefersReducedMotion = window.matchMedia(
        "(prefers-reduced-motion: reduce)",
      ).matches;

      sectionRef.current?.scrollIntoView({
        behavior: prefersReducedMotion ? "auto" : "smooth",
        block: "start",
      });
    });

    return () => cancelAnimationFrame(frame);
  }, [authScrollTarget]);

  return (
    <div className="flex flex-col gap-3">
      {showIntro && (
        <p className="m-0 max-w-[700px] text-caption text-fg-2">
          {t("settings.authCenter.description")}
        </p>
      )}
      <div ref={copilotSectionRef} className="scroll-mt-4">
        <CopilotAuthSection />
      </div>
      <div ref={codexOauthSectionRef} className="scroll-mt-4">
        <CodexOAuthSection showAccountQuota />
      </div>
      <div ref={xaiOauthSectionRef} className="scroll-mt-4">
        <XaiOAuthSection mode="manage" helpSide="top" />
      </div>
    </div>
  );
}
