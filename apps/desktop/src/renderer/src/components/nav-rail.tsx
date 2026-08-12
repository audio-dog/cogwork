import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@clanker-forge/ui/components/sidebar";
import { RiInboxLine, RiLayoutGridLine, RiPulseLine, RiStackLine } from "@remixicon/react";
import { Link, useRouterState } from "@tanstack/react-router";
import type { ComponentType } from "react";
import { registeredWorkspaces } from "../features/feed";
import { useBoard } from "../features/use-board";
import { useChromeStore } from "../store/chrome";

interface View {
  readonly label: string;
  readonly icon: ComponentType;
  readonly to: string;
}

const views: ReadonlyArray<View> = [
  { label: "Feed", icon: RiPulseLine, to: "/" },
  { label: "Board", icon: RiLayoutGridLine, to: "/board" },
  { label: "Inbox", icon: RiInboxLine, to: "/inbox" },
  { label: "Lanes", icon: RiStackLine, to: "/lanes" },
];

function ViewItem({ view }: { view: View }) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });

  return (
    <SidebarMenuItem>
      <SidebarMenuButton isActive={pathname === view.to} render={<Link to={view.to} />} tooltip={view.label}>
        <view.icon />
        <span>{view.label}</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

function WorkspaceFilter() {
  const board = useBoard();
  const filter = useChromeStore((state) => state.workspaceFilter);
  const setFilter = useChromeStore((state) => state.setWorkspaceFilter);
  const workspaces = board._tag === "Success" ? registeredWorkspaces(board.board) : [];

  return (
    <SidebarGroup>
      <SidebarGroupLabel>Workspace</SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              isActive={filter === null}
              onClick={() => setFilter(null)}
              tooltip="All workspaces"
            >
              <span>All workspaces</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          {workspaces.map((workspace) => (
            <SidebarMenuItem key={workspace}>
              <SidebarMenuButton
                isActive={filter === workspace}
                onClick={() => setFilter(workspace)}
                tooltip={workspace}
              >
                <span>{workspace}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

export function NavRail() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });

  return (
    <Sidebar collapsible="icon">
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Views</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {views.map((view) => (
                <ViewItem key={view.label} view={view} />
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <WorkspaceFilter />
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  isActive={pathname === "/activity"}
                  render={<Link to="/activity" />}
                  tooltip="Raw activity"
                >
                  <RiPulseLine />
                  <span>Raw activity</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarRail />
    </Sidebar>
  );
}
