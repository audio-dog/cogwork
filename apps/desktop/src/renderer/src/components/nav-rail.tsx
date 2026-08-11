import { Badge } from "@clanker-forge/ui/components/badge";
import { Button } from "@clanker-forge/ui/components/button";
import { Separator } from "@clanker-forge/ui/components/separator";
import { RiInboxLine, RiLayoutGridLine, RiPulseLine, RiStackLine } from "@remixicon/react";
import { Link, useRouterState } from "@tanstack/react-router";
import type { ComponentType } from "react";
import { registeredWorkspaces } from "../features/feed";
import { useBoard } from "../features/use-board";
import { useChromeStore } from "../store/chrome";

interface View {
  readonly label: string;
  readonly icon: ComponentType;
  readonly to?: string;
}

const views: ReadonlyArray<View> = [
  { label: "Feed", icon: RiPulseLine, to: "/" },
  { label: "Board", icon: RiLayoutGridLine },
  { label: "Inbox", icon: RiInboxLine },
  { label: "Lanes", icon: RiStackLine },
];

function ViewLink({ view }: { view: View }) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });

  if (!view.to) {
    return (
      <Button className="justify-start" disabled size="sm" variant="ghost">
        <view.icon data-icon="inline-start" />
        {view.label}
        <Badge className="ms-auto" variant="outline">
          Soon
        </Badge>
      </Button>
    );
  }

  return (
    <Button
      className="justify-start"
      size="sm"
      variant={pathname === view.to ? "secondary" : "ghost"}
      render={<Link to={view.to} />}
    >
      <view.icon data-icon="inline-start" />
      {view.label}
    </Button>
  );
}

function WorkspaceFilter() {
  const board = useBoard();
  const filter = useChromeStore((state) => state.workspaceFilter);
  const setFilter = useChromeStore((state) => state.setWorkspaceFilter);
  const workspaces = board._tag === "Success" ? registeredWorkspaces(board.board) : [];

  return (
    <div className="flex flex-col gap-1">
      <span className="px-2 py-1 text-xs font-medium text-muted-foreground uppercase">Workspace</span>
      <Button
        className="justify-start"
        size="sm"
        variant={filter === null ? "secondary" : "ghost"}
        onClick={() => setFilter(null)}
      >
        All workspaces
      </Button>
      {workspaces.map((workspace) => (
        <Button
          key={workspace}
          className="justify-start"
          size="sm"
          variant={filter === workspace ? "secondary" : "ghost"}
          onClick={() => setFilter(workspace)}
        >
          <span className="truncate">{workspace}</span>
        </Button>
      ))}
    </div>
  );
}

export function NavRail() {
  return (
    <nav className="flex w-52 flex-col gap-3 border-r p-3">
      <div className="flex flex-col gap-1">
        {views.map((view) => (
          <ViewLink key={view.label} view={view} />
        ))}
      </div>
      <Separator />
      <WorkspaceFilter />
      <Separator />
      <Button
        className="justify-start text-muted-foreground"
        size="sm"
        variant="ghost"
        render={<Link to="/activity" />}
      >
        <RiPulseLine data-icon="inline-start" />
        Raw activity
      </Button>
    </nav>
  );
}
