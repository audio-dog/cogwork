import { Button } from "@clanker-forge/ui/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@clanker-forge/ui/components/tooltip";
import { RiArrowLeftSLine, RiArrowRightSLine } from "@remixicon/react";
import { useCanGoBack, useRouter, useRouterState } from "@tanstack/react-router";
import type { ReactNode } from "react";

// The in-memory history has entries ahead of us whenever the current index is
// not the last one. `useCanGoBack` covers the other direction (index !== 0).
export function canGoForward(input: { index: number; length: number }): boolean {
  return input.index < input.length - 1;
}

function NavButton({
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
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

export function HistoryNav() {
  const router = useRouter();
  const canBack = useCanGoBack();
  const index = useRouterState({ select: (state) => state.location.state.__TSR_index });
  const canForward = canGoForward({ index, length: router.history.length });

  return (
    <div className="flex items-center gap-1">
      <NavButton
        disabled={!canBack}
        icon={<RiArrowLeftSLine />}
        label="Back"
        onClick={() => router.history.back()}
      />
      <NavButton
        disabled={!canForward}
        icon={<RiArrowRightSLine />}
        label="Forward"
        onClick={() => router.history.forward()}
      />
    </div>
  );
}
