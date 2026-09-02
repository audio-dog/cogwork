import { Button } from "@cogwork/ui/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@cogwork/ui/components/tooltip";
import { RiArrowLeftSLine, RiArrowRightSLine } from "@remixicon/react";
import { useCanGoBack, useRouter, useRouterState } from "@tanstack/react-router";
import type { ReactNode } from "react";

// The in-memory history has entries ahead of us whenever the current index is
// not the last one. `useCanGoBack` covers the other direction (index !== 0).
export function canGoForward(input: { index: number; length: number }) {
  return input.index < input.length - 1;
}

function HistoryButton({
  label,
  icon,
  disabled,
  onClick,
}: {
  label: string;
  icon: ReactNode;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button aria-label={label} disabled={disabled} size="icon-sm" variant="ghost" onClick={onClick}>
            {icon}
          </Button>
        }
      />
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

export function HistoryNav() {
  const router = useRouter();
  const canBack = useCanGoBack();
  const index = useRouterState({ select: (state) => state.location.state.__TSR_index });
  const canForward = canGoForward({ index, length: router.history.length });

  return (
    <div className="ml-[var(--workspace-titlebar-content-left)] flex items-center gap-1 [-webkit-app-region:no-drag]">
      <HistoryButton
        disabled={!canBack}
        icon={<RiArrowLeftSLine data-icon="inline-start" />}
        label="Back"
        onClick={() => router.history.back()}
      />
      <HistoryButton
        disabled={!canForward}
        icon={<RiArrowRightSLine data-icon="inline-start" />}
        label="Forward"
        onClick={() => router.history.forward()}
      />
    </div>
  );
}
