import { useIsMobile } from "../../app/viewport.js";
import { useTranslate } from "../../i18n/index.js";
import type { Session } from "../../services/chat/types.js";
import { ChatInput } from "../chatInput/ChatInput.js";
import { MessageList } from "../messages/MessageList.js";
import { DesktopChatHeader } from "./DesktopChatHeader.js";
import { MobileHeader } from "./MobileHeader.js";
import styles from "./SessionView.module.css";

/** 会话页：标题栏（桌面端含窗口拖拽与模型/额度选择器；移动端为顶栏）+ 消息列表，输入框吸底 */
export const SessionView = ({
  session,
  streaming,
  siderCollapsed,
}: {
  session: Session;
  streaming: boolean;
  siderCollapsed: boolean;
}) => {
  const t = useTranslate();
  const isMobile = useIsMobile();
  const title = session.title || t("untitledChat");
  return (
    <div className={styles.view}>
      {isMobile ? (
        <MobileHeader title={title} />
      ) : (
        <DesktopChatHeader title={title} siderCollapsed={siderCollapsed} />
      )}
      <MessageList
        session={session}
        streaming={streaming}
        footer={
          <div className={styles.inputContainer}>
            <ChatInput sessionId={session.id} />
            <div className={styles.caveat}>{t("contentCaveat")}</div>
          </div>
        }
      />
    </div>
  );
};
