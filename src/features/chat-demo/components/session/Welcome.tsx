import { useIsMobile } from "../../app/viewport.js";
import { useTranslate } from "../../i18n/index.js";
import { ChatInput } from "../chatInput/ChatInput.js";
import { DesktopChatHeader } from "./DesktopChatHeader.js";
import { MobileHeader } from "./MobileHeader.js";
import styles from "./Welcome.module.css";

/** 新对话：顶栏（模型与额度选择）+ 问候语 + 输入框 */
export const Welcome = () => {
  const t = useTranslate();
  const isMobile = useIsMobile();
  return (
    <div className={styles.container}>
      {isMobile ? <MobileHeader /> : <DesktopChatHeader />}
      <div className={styles.welcome}>
        <div className={styles.greeting}>{t("welcomeMessageChat250808")}</div>
        <ChatInput sessionId={null} />
        {isMobile ? (
          <div className={styles.caveat}>{t("contentCaveat")}</div>
        ) : null}
      </div>
    </div>
  );
};
