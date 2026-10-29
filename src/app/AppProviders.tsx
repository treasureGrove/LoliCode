import { StrictMode, type ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MotionConfig } from "framer-motion";
import { FrontendErrorBoundary } from "@/components/FrontendErrorBoundary";
import { ThemeProvider } from "@/components/theme-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { ResourcePackProvider } from "@/app/shell/ResourcePackProvider";
import { InterfaceAppearanceRoot } from "@/app/shell/InterfaceAppearanceRoot";
import { RendererBootHealth } from "@/app/shell/RendererBootHealth";
import { UpdateProvider } from "@/contexts/UpdateContext";
import { queryClient } from "@/lib/query";

/** Normal application providers; recovery screens intentionally use a smaller tree. */
export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <StrictMode>
      <FrontendErrorBoundary>
        <QueryClientProvider client={queryClient}>
          <ThemeProvider defaultTheme="system" storageKey="lolicode-theme">
            <UpdateProvider>
              {/* 系统开了「减少动态效果」时，framer-motion 的位移动画一律跳过 */}
              <MotionConfig reducedMotion="user">
                {/* 全局悬停提示：移上去立即出现（HoverTip） */}
                <TooltipProvider delayDuration={0} skipDelayDuration={0}>
                  <InterfaceAppearanceRoot />
                  <ResourcePackProvider>
                    {children}
                    <RendererBootHealth />
                  </ResourcePackProvider>
                </TooltipProvider>
              </MotionConfig>
              <Toaster />
            </UpdateProvider>
          </ThemeProvider>
        </QueryClientProvider>
      </FrontendErrorBoundary>
    </StrictMode>
  );
}
