import * as React from "react";
import * as SwitchPrimitives from "@radix-ui/react-switch";
import { cn } from "@/lib/utils";

export interface SwitchProps
  extends React.ComponentPropsWithoutRef<typeof SwitchPrimitives.Root> {
  /** default：30×18；sm：26×16，给表格里成排的开关用 */
  size?: "default" | "sm";
}

const Switch = React.forwardRef<
  React.ElementRef<typeof SwitchPrimitives.Root>,
  SwitchProps
>(({ className, size = "default", ...props }, ref) => (
  <SwitchPrimitives.Root
    ref={ref}
    data-size={size}
    className={cn(
      // 扩大命中区域，保留紧凑表格布局。
      "tai-switch peer relative inline-flex shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent before:absolute before:-inset-x-2 before:-inset-y-3 before:content-[''] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface disabled:cursor-not-allowed disabled:opacity-45 data-[state=checked]:bg-action data-[state=unchecked]:bg-control-off",
      size === "sm" ? "h-4 w-[26px]" : "h-[18px] w-[30px]",
      className,
    )}
    {...props}
  >
    <SwitchPrimitives.Thumb
      className={cn(
        "tai-switch-thumb pointer-events-none block rounded-full bg-white shadow-sm ring-0 data-[state=unchecked]:translate-x-0",
        size === "sm"
          ? "h-3 w-3 data-[state=checked]:translate-x-2.5"
          : "h-3.5 w-3.5 data-[state=checked]:translate-x-3",
      )}
    />
  </SwitchPrimitives.Root>
));
Switch.displayName = SwitchPrimitives.Root.displayName;

export { Switch };
