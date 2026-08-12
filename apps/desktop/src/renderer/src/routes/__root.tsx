import { Badge } from "@clanker-forge/ui/components/badge";
import { Button } from "@clanker-forge/ui/components/button";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@clanker-forge/ui/components/sidebar";
import { Switch } from "@clanker-forge/ui/components/switch";
import { TooltipProvider } from "@clanker-forge/ui/components/tooltip";
import { RiSidebarFoldLine, RiSidebarUnfoldLine } from "@remixicon/react";
import { createRootRoute, Outlet, useRouterState } from "@tanstack/react-router";
import type { ComponentProps } from "react";
import { AttentionRail } from "../components/attention-rail";
import { NavRail } from "../components/nav-rail";
import { SchedulerGauges } from "../components/scheduler-gauges";
import { type EngineStatusValue, engineIsOn, useEngineStatus } from "../features/use-engine-status";
import { useChromeStore } from "../store/chrome";

type BadgeVariant = ComponentProps<typeof Badge>["variant"];

const engineBadge: Record<EngineStatusValue, { label: string; variant: BadgeVariant }> = {
  unknown: { label: "…", variant: "outline" },
  starting: { label: "Starting", variant: "secondary" },
  running: { label: "Running", variant: "default" },
  adopted: { label: "Adopted", variant: "default" },
  stopped: { label: "Stopped", variant: "outline" },
  failed: { label: "Failed", variant: "destructive" },
};

function EngineControl() {
  const { status, setEnabled } = useEngineStatus();
  const badge = engineBadge[status];

  return (
    <div className="flex items-center gap-3">
      <span className="text-sm text-muted-foreground">Engine</span>
      <Badge variant={badge.variant}>{badge.label}</Badge>
      <Switch
        aria-label="Toggle engine"
        checked={engineIsOn(status)}
        disabled={status === "starting"}
        onCheckedChange={setEnabled}
      />
    </div>
  );
}

function RootLayout() {
  const attentionCollapsed = useChromeStore((state) => state.attentionCollapsed);
  const toggleAttention = useChromeStore((state) => state.toggleAttention);
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const railCollapsed = attentionCollapsed || pathname === "/lanes";

  return (
    <TooltipProvider>
      <SidebarProvider>
        <NavRail />
        <SidebarInset className="h-svh overflow-hidden">
          <header className="flex items-center justify-between border-b px-6 py-3">
            <div className="flex items-center gap-2">
              <SidebarTrigger />
              <h1 className="text-lg font-semibold">clanker-forge</h1>
            </div>
            <div className="flex items-center gap-4">
              <EngineControl />
              {pathname !== "/lanes" && (
                <Button
                  aria-label={attentionCollapsed ? "Show attention" : "Hide attention"}
                  size="icon-sm"
                  variant="ghost"
                  onClick={toggleAttention}
                >
                  {attentionCollapsed ? <RiSidebarUnfoldLine /> : <RiSidebarFoldLine />}
                </Button>
              )}
            </div>
          </header>

          <SchedulerGauges />

          <div className="flex min-h-0 flex-1">
            <div className="min-w-0 flex-1">
              <Outlet />
            </div>
            {!railCollapsed && <AttentionRail />}
          </div>
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  );
}

export const Route = createRootRoute({
  component: RootLayout,
});
