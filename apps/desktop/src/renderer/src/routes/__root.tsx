import { Badge } from "@clanker-forge/ui/components/badge";
import { Button } from "@clanker-forge/ui/components/button";
import { Switch } from "@clanker-forge/ui/components/switch";
import { RiSidebarFoldLine, RiSidebarUnfoldLine } from "@remixicon/react";
import { createRootRoute, Link, Outlet, useRouterState } from "@tanstack/react-router";
import type { ComponentProps } from "react";
import { type EngineStatusValue, useEngineStatus } from "../features/use-engine-status";
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

const engineIsOn = (status: EngineStatusValue) =>
  status === "running" || status === "starting" || status === "adopted";

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

function NavLink({ to, label }: { to: string; label: string }) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  return (
    <Button size="sm" variant={pathname === to ? "secondary" : "ghost"} render={<Link to={to} />}>
      {label}
    </Button>
  );
}

function RootLayout() {
  const railCollapsed = useChromeStore((state) => state.railCollapsed);
  const toggleRail = useChromeStore((state) => state.toggleRail);

  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex items-center justify-between border-b px-6 py-3">
        <div className="flex items-center gap-2">
          <Button
            aria-label={railCollapsed ? "Expand rail" : "Collapse rail"}
            size="icon-sm"
            variant="ghost"
            onClick={toggleRail}
          >
            {railCollapsed ? <RiSidebarUnfoldLine /> : <RiSidebarFoldLine />}
          </Button>
          <h1 className="text-lg font-semibold">clanker-forge</h1>
        </div>
        <EngineControl />
      </header>

      <div className="flex flex-1">
        {!railCollapsed && (
          <nav className="flex w-44 flex-col gap-1 border-r p-3">
            <NavLink to="/" label="Overview" />
            <NavLink to="/activity" label="Activity" />
          </nav>
        )}
        <main className="flex-1 p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

export const Route = createRootRoute({
  component: RootLayout,
});
