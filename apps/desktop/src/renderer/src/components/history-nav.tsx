import { Button } from "@cogwork/ui/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@cogwork/ui/components/tooltip";
import { RiArrowLeftSLine, RiArrowRightSLine } from "@remixicon/react";
import { useCanGoBack, useRouter, useRouterState } from "@tanstack/react-router";

// The in-memory history has entries ahead of us whenever the current index is
// not the last one. `useCanGoBack` covers the other direction (index !== 0).
export function canGoForward(input: { index: number; length: number }) {
  return input.index < input.length - 1;
}

export function HistoryNav() {
  const router = useRouter();
  const canBack = useCanGoBack();
  const index = useRouterState({ select: (state) => state.location.state.__TSR_index });
  const canForward = canGoForward({ index, length: router.history.length });
  const buttons = [
    {
      disabled: !canBack,
      icon: <RiArrowLeftSLine data-icon="inline-start" />,
      label: "Back",
      onClick: () => router.history.back(),
    },
    {
      disabled: !canForward,
      icon: <RiArrowRightSLine data-icon="inline-start" />,
      label: "Forward",
      onClick: () => router.history.forward(),
    },
  ];

  return (
    <div className="ml-[var(--workspace-titlebar-content-left)] flex items-center gap-1 [-webkit-app-region:no-drag]">
      {buttons.map((button) => (
        <Tooltip key={button.label}>
          <TooltipTrigger render={<span className="inline-flex" />}>
            <Button
              aria-label={button.label}
              disabled={button.disabled}
              size="icon-sm"
              variant="ghost"
              onClick={button.onClick}
            >
              {button.icon}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{button.label}</TooltipContent>
        </Tooltip>
      ))}
    </div>
  );
}
