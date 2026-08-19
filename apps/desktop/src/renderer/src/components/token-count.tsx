import type { RunSummary } from "@cogwork/contracts";
import { Tooltip, TooltipContent, TooltipTrigger } from "@cogwork/ui/components/tooltip";
import type { ReactNode } from "react";
import { tokenCountLabel } from "../features/token-usage";

export function TokenCount({
  usage,
  variant = "full",
  fallback = null,
}: {
  usage: RunSummary["usage"];
  variant?: "full" | "compact";
  fallback?: ReactNode;
}) {
  const label = tokenCountLabel(usage);
  if (label === null) return fallback;
  const text = variant === "compact" ? label.text : `${label.text} tokens`;
  if (!label.estimated) return <span className="tabular-nums">{text}</span>;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className="cursor-help underline decoration-dotted underline-offset-2 tabular-nums">
            {text}
          </span>
        }
      />
      <TooltipContent>
        Best-guess estimate. Cursor's ACP mode doesn't report token usage, so this is derived from the prompt
        and streamed text length.
      </TooltipContent>
    </Tooltip>
  );
}
