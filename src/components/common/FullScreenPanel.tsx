import React from "react";
import { createPortal } from "react-dom";
import {
  motion,
  AnimatePresence,
  useReducedMotion,
  useIsPresent,
  type HTMLMotionProps,
} from "framer-motion";
import { ChevronLeft } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { HoverTip } from "@/components/ui/hover-tip";
import { AppPageHeader } from "@/app/shell/AppPageHeader";
import { useUnsavedChangesTracker } from "@/lib/unsavedChanges";
import { cn } from "@/lib/utils";
import { motionTokens } from "@/lib/motion";
import { isTextEditableTarget } from "@/utils/domUtils";

interface FullScreenPanelProps {
  isOpen: boolean;
  title: string;
  /** 标题后的灰字（应用名） */
  subtitle?: React.ReactNode;
  /** 返回按钮的读屏文字，默认「返回」 */
  backLabel?: string;
  /** 页头右侧 */
  actions?: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  /** Opaque, short-distance movement keeps the editing surface legible. */
  motionPreset?: "none" | "fade" | "slide-from-right";
  /**
   * 覆盖内容区滚动容器的内边距/间距类。默认 `px-6 py-6 space-y-6`。
   * 通过 `cn`(twMerge) 合并，传入如 `pt-3` 只覆盖顶部内边距，其余保持默认。
   */
  contentClassName?: string;
  /**
   * 编辑表单：用户改过内容后，从侧栏、托盘、⌘, 离开当前页前会先确认。
   * 只给编辑页打开；授权中心、测速这类页面不需要。
   */
  trackUnsavedChanges?: boolean;
  /** Enable only when onClose itself protects an unfinished draft. */
  closeOnInputEscape?: boolean;
}

/** 外壳里的内容区（App 的 <main id="content-area">）：二级页只盖住它，侧栏留着 */
const CONTENT_AREA_ID = "content-area";

let bodyScrollLockCount = 0;
let bodyOverflowBeforeFirstLock: string | null = null;
const PanelDepthContext = React.createContext(0);
const panelStack: Array<{
  node: HTMLElement;
  depth: number;
  present: boolean;
}> = [];
const pageLocks = new Map<HTMLElement, { count: number; inert: boolean }>();

function syncPanelStack() {
  panelStack.sort((a, b) => a.depth - b.depth);
  panelStack.forEach(({ node, present }, index) => {
    node.inert = !present || index !== panelStack.length - 1;
    if (node.inert) node.setAttribute("aria-hidden", "true");
    else node.removeAttribute("aria-hidden");
  });
}

/** Exiting DOM is visual only; it cannot receive input or duplicate live IDs. */
const PanelSurface = React.forwardRef<HTMLDivElement, HTMLMotionProps<"div">>(
  (props, forwardedRef) => {
    const localRef = React.useRef<HTMLDivElement>(null);
    const present = useIsPresent();
    const namespace = React.useId();
    const depth = React.useContext(PanelDepthContext);
    React.useImperativeHandle(forwardedRef, () => localRef.current!);
    React.useLayoutEffect(() => {
      const panel = localRef.current;
      if (!panel) return;
      const previousFocus =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      const page = document
        .getElementById(CONTENT_AREA_ID)
        ?.querySelector<HTMLElement>(".tai-page");
      if (page) {
        const lock = pageLocks.get(page) ?? { count: 0, inert: page.inert };
        lock.count += 1;
        pageLocks.set(page, lock);
        page.inert = true;
      }
      const entry = { node: panel, depth, present: true };
      panelStack.push(entry);
      syncPanelStack();
      if (
        panelStack.at(-1)?.node === panel &&
        !panel.contains(document.activeElement)
      )
        panel.focus({ preventScroll: true });
      lockBodyScroll();
      return () => {
        const restoreFocus =
          panel.contains(document.activeElement) ||
          document.activeElement === document.body;
        const index = panelStack.indexOf(entry);
        if (index >= 0) panelStack.splice(index, 1);
        syncPanelStack();
        if (page) {
          const lock = pageLocks.get(page);
          if (lock && --lock.count === 0) {
            page.inert = lock.inert;
            pageLocks.delete(page);
          }
        }
        unlockBodyScroll();
        if (
          restoreFocus &&
          previousFocus?.isConnected &&
          !previousFocus.closest("[inert]")
        ) {
          previousFocus.focus({ preventScroll: true });
        }
      };
    }, [depth]);

    React.useLayoutEffect(() => {
      const node = localRef.current;
      if (!node) return;
      const entry = panelStack.find((item) => item.node === node);
      if (entry) entry.present = present;
      syncPanelStack();
      if (present) return;
      const ids = Array.from(node.querySelectorAll<HTMLElement>("[id]")).map(
        (element) => ({ element, id: element.id }),
      );
      ids.forEach(({ element, id }) => {
        element.id = `${namespace}-exit-${id}`;
      });
      return () => {
        ids.forEach(({ element, id }) => {
          element.id = id;
        });
        if (entry) entry.present = true;
        syncPanelStack();
      };
    }, [present, namespace]);
    return <motion.div ref={localRef} {...props} />;
  },
);
PanelSurface.displayName = "PanelSurface";

const lockBodyScroll = () => {
  if (bodyScrollLockCount === 0) {
    bodyOverflowBeforeFirstLock = document.body.style.overflow;
    document.body.style.overflow = "hidden";
  }
  bodyScrollLockCount += 1;
};

const unlockBodyScroll = () => {
  bodyScrollLockCount = Math.max(0, bodyScrollLockCount - 1);
  if (bodyScrollLockCount === 0) {
    document.body.style.overflow = bodyOverflowBeforeFirstLock ?? "";
    bodyOverflowBeforeFirstLock = null;
  }
};

/**
 * Reusable full-screen panel component
 * Handles portal rendering, header with back button, and footer
 * Uses solid theme colors without transparency
 */
export const FullScreenPanel: React.FC<FullScreenPanelProps> = ({
  isOpen,
  title,
  subtitle,
  backLabel,
  actions,
  onClose,
  children,
  footer,
  contentClassName,
  motionPreset = "slide-from-right",
  trackUnsavedChanges = false,
  closeOnInputEscape = false,
}) => {
  // 面板关掉后组件可能还挂着：只在打开时登记，关掉即撤销
  const unsavedChangesHandlers = useUnsavedChangesTracker(
    trackUnsavedChanges && isOpen,
  );
  const { t } = useTranslation();
  const panelRef = React.useRef<HTMLDivElement>(null);
  const depth = React.useContext(PanelDepthContext);
  const prefersReducedMotion = useReducedMotion();
  const disableMotion = motionPreset === "none" || prefersReducedMotion;
  const shouldSlideFromRight =
    motionPreset === "slide-from-right" && !prefersReducedMotion;

  // ESC 键关闭面板
  const onCloseRef = React.useRef(onClose);

  React.useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  React.useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        // 子组件（例如 Radix 的 Select/Dialog/Dropdown）如果已经消费了 ESC，就不要再关闭整个面板
        if (
          event.defaultPrevented ||
          panelStack.at(-1)?.node !== panelRef.current
        ) {
          return;
        }
        if (!closeOnInputEscape && isTextEditableTarget(event.target)) return;
        event.preventDefault();
        event.stopPropagation(); // 阻止事件继续冒泡到 window，避免触发 App.tsx 的全局监听
        onCloseRef.current();
      }
    };

    // 使用冒泡阶段监听，让子组件（如 Radix UI）优先处理 ESC
    window.addEventListener("keydown", handleKeyDown, false);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, false);
    };
  }, [isOpen, closeOnInputEscape]);

  const host =
    typeof document !== "undefined"
      ? document.getElementById(CONTENT_AREA_ID)
      : null;

  return createPortal(
    <PanelDepthContext.Provider value={depth + 1}>
      <AnimatePresence>
        {isOpen && (
          <PanelSurface
            ref={panelRef}
            role="region"
            aria-label={title}
            tabIndex={-1}
            initial={
              disableMotion
                ? false
                : shouldSlideFromRight
                  ? { x: 28, opacity: 1 }
                  : { opacity: 0 }
            }
            animate={{ x: 0, opacity: 1 }}
            exit={
              disableMotion
                ? { x: 0, opacity: 1 }
                : shouldSlideFromRight
                  ? { x: 28, opacity: 0 }
                  : { opacity: 0 }
            }
            transition={
              shouldSlideFromRight
                ? {
                    duration: motionTokens.duration.panel,
                    ease: motionTokens.ease,
                  }
                : { duration: disableMotion ? 0 : 0.2 }
            }
            className={cn(
              "tai-editor-panel inset-0 z-[60] flex flex-col bg-app outline-none",
              host ? "absolute" : "fixed",
            )}
          >
            <AppPageHeader
              variant="app"
              title={title}
              // 标题里常带用户起的名字，不限长度；必须能收缩截断，否则会把窗口按钮挤出可视区
              truncateTitle
              subtitle={subtitle}
              actions={actions}
              leading={
                <HoverTip content={backLabel ?? t("common.back")}>
                  <Button
                    type="button"
                    variant="quiet"
                    size="icon-compact"
                    className="h-8 w-8"
                    onClick={onClose}
                    aria-label={backLabel ?? t("common.back")}
                  >
                    <ChevronLeft className="h-4 w-4" strokeWidth={1.5} />
                  </Button>
                </HoverTip>
              }
            />

            <div className="min-h-0 flex-1 overflow-y-auto scroll-stable overscroll-contain">
              <div
                className={cn("w-full space-y-6 px-6 py-6", contentClassName)}
                {...unsavedChangesHandlers}
              >
                {children}
              </div>
            </div>

            {footer && (
              <div className="flex h-14 shrink-0 items-center justify-end gap-2 border-t border-border px-6">
                {footer}
              </div>
            )}
          </PanelSurface>
        )}
      </AnimatePresence>
    </PanelDepthContext.Provider>,
    host ?? document.body,
  );
};
