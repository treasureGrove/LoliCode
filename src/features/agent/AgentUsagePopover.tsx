import { useId, type ComponentProps } from "react";
import { ChartNoAxesColumn } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { AgentUsageFooter } from "./AgentUsageFooter";

/** Keep accounting available without adding another row below the editor. */
export function AgentUsagePopover(
  props: ComponentProps<typeof AgentUsageFooter>,
) {
  const headingId = useId();
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="wb-composer-usage"
          aria-label="查看会话用量"
          title="查看会话用量"
        >
          <ChartNoAxesColumn aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        collisionPadding={12}
        aria-labelledby={headingId}
        className="wb-usage-popover"
      >
        <h2 id={headingId}>本会话用量</h2>
        <AgentUsageFooter {...props} />
      </PopoverContent>
    </Popover>
  );
}
