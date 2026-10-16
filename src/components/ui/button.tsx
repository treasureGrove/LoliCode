import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "tai-button inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-control text-body font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface disabled:pointer-events-none disabled:opacity-45",
  {
    variants: {
      variant: {
        default:
          "border border-transparent bg-action font-semibold text-action-fg shadow-v7-sm hover:bg-action-hover",
        destructive:
          "border border-transparent bg-danger text-white hover:brightness-110",
        outline:
          "border border-border bg-surface text-fg-1 shadow-v7-sm hover:border-border-strong hover:bg-subtle",
        secondary: "text-fg-2 hover:bg-subtle hover:text-fg-1",
        ghost: "text-fg-2 hover:bg-subtle hover:text-fg-1",
        mcp: "border border-transparent bg-action font-semibold text-action-fg shadow-v7-sm hover:bg-action-hover",
        link: "text-action-text underline-offset-4 hover:underline",
        solid:
          "border border-transparent bg-action font-semibold text-action-fg shadow-v7-sm hover:bg-action-hover",
        neutral:
          "border border-border bg-surface text-fg-1 shadow-v7-sm hover:border-border-strong hover:bg-subtle disabled:opacity-100 disabled:border-border disabled:bg-transparent disabled:text-fg-3 disabled:shadow-none",
        quiet: "border border-transparent text-fg-1 hover:bg-subtle",
        direct:
          "border border-transparent bg-direct-solid text-direct-on font-semibold hover:brightness-110",
        route:
          "border border-transparent bg-route-solid text-route-on font-semibold hover:brightness-110",
        stack:
          "border border-transparent bg-stack-solid text-stack-on font-semibold hover:brightness-110",
      },
      size: {
        default: "h-8 px-3.5",
        sm: "h-7 px-3",
        lg: "h-9 px-4",
        icon: "h-8 w-8 p-0",
        compact: "h-7 px-3",
        regular: "h-8 px-3.5",
        "icon-compact": "h-7 w-7 p-0 text-fg-2 hover:text-fg-1",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
