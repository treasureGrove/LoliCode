import clsx from "clsx";
import { useEffect } from "react";
import { useTranslate } from "../i18n/index.js";
import { setOpenChannelsCallback, useSettings } from "../services/settings.js";
import { setupTheme, useTheme } from "./theme.js";
import {
  useIsMobile,
  useMobileViewport,
  usePreventPageScroll,
} from "./viewport.js";
import {
  bindChatPersistence,
  initChat,
  retrySaveSessions,
  selectSession,
  useChatStore,
} from "../services/chat/store.js";
import { SearchPanel } from "../components/search/SearchPanel.js";
import { closeSearchPanel } from "../components/search/searchPanelState.js";
import { SessionView } from "../components/session/SessionView.js";
import { MobileHeader } from "../components/session/MobileHeader.js";
import { Welcome } from "../components/session/Welcome.js";
import { SettingsDialog } from "../components/settings/SettingsDialog.js";
import { Toast } from "../components/base/Toast.js";
import { showToast } from "../components/base/toastState.js";
import { onUploadNotice } from "../services/attachments.js";
import { Button } from "../components/base/Button.js";
import { stopReadAloud } from "../services/speech/readAloud.js";
import { CollapsedSider } from "../components/sider/CollapsedSider.js";
import { closeMobileSider } from "../components/sider/mobileSiderState.js";
import { MobileSider, Sider } from "../components/sider/Sider.js";
import "./theme.css";
import "./global.css";
import styles from "./App.module.css";

export const App = ({
  isActive = true,
  embedded = false,
  onOpenChannels,
}: {
  isActive?: boolean;
  embedded?: boolean;
  onOpenChannels?: () => void;
} = {}) => {
  useEffect(() => {
    setOpenChannelsCallback(onOpenChannels);
    return () => setOpenChannelsCallback(undefined);
  }, [onOpenChannels]);
  const t = useTranslate();
  const isMobile = useIsMobile();
  const theme = useTheme();
  // 移动端侧边栏以独立抽屉管理开合状态；嵌入桌面端统一侧栏时不重复渲染内嵌侧栏
  const siderCollapsed =
    !embedded && useSettings((state) => state.siderCollapsed) && !isMobile;
  const ready = useChatStore((state) => state.ready);
  const initError = useChatStore((state) => state.initError);
  const saveError = useChatStore((state) =>
    Object.values(state.sessionSaveErrors).some(Boolean),
  );
  const importingHistory = useChatStore((state) => state.importingHistory);
  const session = useChatStore((state) =>
    state.activeId !== null && Object.hasOwn(state.sessionCache, state.activeId)
      ? state.sessionCache[state.activeId]
      : undefined,
  );
  const sessionLoadError = useChatStore((state) =>
    state.activeId === null
      ? false
      : state.sessionLoadErrors[state.activeId] === true,
  );
  const frameRef = useMobileViewport(isMobile);
  const streaming = useChatStore((state) =>
    state.activeId === null
      ? false
      : Object.hasOwn(state.streaming, state.activeId),
  );
  const activeId = useChatStore((state) => state.activeId);

  usePreventPageScroll(isMobile && isActive);

  useEffect(() => {
    setupTheme();
  }, []);

  // 文件数、存储空间达到上限时，附件上只显示「上传失败」，原因用 toast 说明
  useEffect(() => onUploadNotice(showToast), []);
  useEffect(bindChatPersistence, []);

  // 搜索结果面板只属于当前会话
  useEffect(closeSearchPanel, [activeId]);
  // 切换会话或离开对话视图时停止朗读
  useEffect(() => {
    if (!isActive) stopReadAloud();
  }, [activeId, isActive]);
  // 移动端选中会话、切换布局后收起抽屉
  useEffect(closeMobileSider, [activeId, isMobile]);

  useEffect(() => {
    void initChat();
  }, []);

  return (
    <>
      <div
        id={isActive ? "main-content" : undefined}
        ref={frameRef}
        data-ds-dark-theme={theme === "dark" ? "dark" : undefined}
        className={clsx("ds-chat-demo-root", styles.frame)}
      >
        {isMobile ? (
          <MobileSider />
        ) : embedded || siderCollapsed ? null : (
          <Sider />
        )}
        <div className={styles.main}>
          {saveError ? (
            <div className={styles.saveError} role="alert">
              <span>{t("sessionSaveFailed")}</span>
              <Button
                variant="outlined"
                size="s"
                disabled={importingHistory}
                onClick={retrySaveSessions}
              >
                {t("retry")}
              </Button>
            </div>
          ) : null}
          <div className={styles.content}>
            {siderCollapsed ? <CollapsedSider /> : null}
            {!ready || (activeId !== null && !session) ? (
              <div className={styles.loadingView}>
                {isMobile ? <MobileHeader /> : null}
                <div
                  className={styles.loadingState}
                  role="status"
                  aria-live="polite"
                >
                  <span>
                    {(!ready ? initError : sessionLoadError)
                      ? t(
                          !ready
                            ? "sessionListLoadFailed"
                            : "sessionLoadFailed",
                        )
                      : t("sessionLoading")}
                  </span>
                  {(!ready ? initError : sessionLoadError) ? (
                    <Button
                      variant="outlined"
                      size="m"
                      onClick={() => {
                        if (!ready) {
                          void initChat();
                        } else if (activeId !== null) {
                          selectSession(activeId);
                        }
                      }}
                    >
                      {t("retry")}
                    </Button>
                  ) : null}
                </div>
              </div>
            ) : session ? (
              <SessionView
                session={session}
                streaming={streaming}
                siderCollapsed={siderCollapsed}
              />
            ) : (
              <Welcome />
            )}
          </div>
        </div>
        <SearchPanel />
      </div>
      {isActive ? (
        <>
          <SettingsDialog />
          <Toast />
        </>
      ) : null}
    </>
  );
};
