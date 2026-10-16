import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * 输入、文本域、选择器共用的表面与聚焦反馈。
 */
export const fieldClass =
  "tai-field w-full rounded-control border border-border bg-surface px-3 text-body text-fg-1 placeholder:text-fg-3 hover:enabled:border-border-strong focus:border-ring focus:outline-none focus:ring-[3px] focus:ring-ring/15 focus-visible:outline-none aria-[invalid=true]:border-danger disabled:cursor-not-allowed disabled:opacity-45";

export type InputProps = React.InputHTMLAttributes<HTMLInputElement>;

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          fieldClass,
          "flex h-8 py-1 file:border-0 file:bg-transparent file:text-body file:font-medium file:text-fg-1",
          className,
        )}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        ref={ref}
        {...props}
      />
    );
  },
);
Input.displayName = "Input";

export { Input };
