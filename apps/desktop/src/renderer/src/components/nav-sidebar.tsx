import type { WorkspaceId } from "@cogwork/contracts";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@cogwork/ui/components/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@cogwork/ui/components/sidebar";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@cogwork/ui/components/tooltip";
import {
  RiAlertLine,
  RiEqualizerLine,
  RiFocus2Line,
  RiNodeTree,
  RiPlugLine,
  RiPulseLine,
  RiSettings3Line,
  RiSettings4Line,
  RiUserLine,
} from "@remixicon/react";
import { Link, useRouterState } from "@tanstack/react-router";
import type { ComponentType } from "react";
import { BoardResult, useBoard } from "../features/activity-session";
import { type FailedWorkspace, failedWorkspaces, registeredWorkspaceOptions } from "../features/feed";

type FailedWorkspaceWithId = FailedWorkspace & { readonly id: WorkspaceId };

import { useChromeStore } from "../store/chrome";
import { HistoryNav } from "./history-nav";
import { useTheme } from "./theme-provider";

interface View {
  readonly label: string;
  readonly icon: ComponentType;
  readonly to: string;
}

const views: ReadonlyArray<View> = [
  { label: "Feed", icon: RiPulseLine, to: "/" },
  { label: "Attention", icon: RiFocus2Line, to: "/attention" },
  { label: "Workflows", icon: RiNodeTree, to: "/workflows" },
  { label: "Connections", icon: RiPlugLine, to: "/connections" },
  { label: "Customize", icon: RiEqualizerLine, to: "/customize" },
];

const isViewActive = (pathname: string, to: string) =>
  to === "/" ? pathname === "/" : pathname.startsWith(to);

function ViewItem({ view }: { view: View }) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        isActive={isViewActive(pathname, view.to)}
        render={<Link to={view.to} />}
        tooltip={view.label}
      >
        <view.icon />
        <span>{view.label}</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

/** A Failed workspace cannot filter the feed, so its row opens the settings that explain it. */
function FailedWorkspaceItem({ workspace }: { readonly workspace: FailedWorkspaceWithId }) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        tooltip={workspace.message}
        render={<Link to="/workspaces/$workspaceId" params={{ workspaceId: workspace.id }} />}
      >
        <RiAlertLine className="text-destructive" />
        <span>{workspace.label}</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

/** Register never minted this one an id, so there is no settings page to send it to. */
function UnregisteredWorkspaceItem({ workspace }: { readonly workspace: FailedWorkspace }) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton tooltip={workspace.message} className="cursor-default">
        <RiAlertLine className="text-destructive" />
        <span className="text-muted-foreground">{workspace.label}</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

function WorkspaceFilter() {
  const board = useBoard();
  const filter = useChromeStore((state) => state.workspaceFilter);
  const setFilter = useChromeStore((state) => state.setWorkspaceFilter);
  const picture = BoardResult.$is("Success")(board) ? board.board : null;
  const workspaces = picture ? registeredWorkspaceOptions(picture) : [];
  const failed = picture ? failedWorkspaces(picture) : [];

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
            <SidebarMenuItem key={workspace.id}>
              <SidebarMenuButton
                isActive={filter === workspace.id}
                onClick={() => setFilter(workspace.id)}
                tooltip={workspace.label}
              >
                <span>{workspace.label}</span>
              </SidebarMenuButton>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <SidebarMenuAction
                      showOnHover
                      aria-label={`${workspace.label} settings`}
                      render={<Link to="/workspaces/$workspaceId" params={{ workspaceId: workspace.id }} />}
                    />
                  }
                >
                  <RiSettings4Line />
                </TooltipTrigger>
                <TooltipContent side="right">Workspace settings</TooltipContent>
              </Tooltip>
            </SidebarMenuItem>
          ))}
          {failed.map((workspace) =>
            workspace.id === null ? (
              <UnregisteredWorkspaceItem key={workspace.label} workspace={workspace} />
            ) : (
              <FailedWorkspaceItem key={workspace.id} workspace={{ ...workspace, id: workspace.id }} />
            ),
          )}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

function UserButton() {
  const { theme, setTheme } = useTheme();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <SidebarMenuButton tooltip="Account" className="gap-2">
            <RiUserLine />
            <span>Account</span>
          </SidebarMenuButton>
        }
      />
      <DropdownMenuContent side="top" align="start" className="min-w-48">
        <DropdownMenuItem render={<Link to="/settings" />}>
          <RiSettings3Line />
          Settings
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup value={theme} onValueChange={(value) => setTheme(value as typeof theme)}>
          <DropdownMenuLabel>Theme</DropdownMenuLabel>
          <DropdownMenuRadioItem value="system">System</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="light">Light</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark">Dark</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function AppSidebar() {
  return (
    <TooltipProvider>
      <Sidebar collapsible="offcanvas">
        <SidebarHeader className="@container/sidebar-header h-11 shrink-0 flex-row items-center px-3 py-0 [-webkit-app-region:drag]">
          <HistoryNav />
          <Link
            aria-label="cogwork home"
            to="/"
            className="hidden h-7 w-fit min-w-0 shrink-0 items-center overflow-hidden rounded-md tracking-tight outline-hidden ring-ring @min-[15.75rem]/sidebar-header:flex focus-visible:ring-2 [-webkit-app-region:no-drag]"
          >
            <span className="truncate text-sm font-semibold">cog</span>
            <span className="truncate text-sm font-medium text-muted-foreground">work</span>
          </Link>
        </SidebarHeader>
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
        </SidebarContent>
        <SidebarFooter>
          <SidebarMenu>
            <SidebarMenuItem>
              <UserButton />
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
      </Sidebar>
    </TooltipProvider>
  );
}
