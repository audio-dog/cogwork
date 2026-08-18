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
  SidebarMenuButton,
  SidebarMenuItem,
} from "@cogwork/ui/components/sidebar";
import { RiFlaskLine, RiPulseLine, RiSettings3Line, RiUserLine } from "@remixicon/react";
import { Link, useRouterState } from "@tanstack/react-router";
import type { ComponentType } from "react";
import { registeredWorkspaces } from "../features/feed";
import { useBoard } from "../features/use-board";
import { useChromeStore } from "../store/chrome";
import { useTheme } from "./theme-provider";

interface View {
  readonly label: string;
  readonly icon: ComponentType;
  readonly to: string;
}

const views: ReadonlyArray<View> = [
  { label: "Feed", icon: RiPulseLine, to: "/" },
  // PROTOTYPE — throwaway link for the item-tab layout prototype (ticket #25). Remove with the prototype.
  { label: "Item tab (proto)", icon: RiFlaskLine, to: "/item-tab-prototype" },
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
        <DropdownMenuItem disabled>
          <RiSettings3Line />
          Settings (coming soon)
        </DropdownMenuItem>
        <DropdownMenuItem render={<Link to="/activity" />}>
          <RiPulseLine />
          Raw activity
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

export function NavSidebar() {
  return (
    <Sidebar collapsible="offcanvas">
      <SidebarHeader className="@container/sidebar-header h-11 shrink-0 flex-row items-center px-3 py-0 [-webkit-app-region:drag]">
        <Link
          aria-label="cogwork home"
          to="/"
          className="ml-[var(--workspace-titlebar-content-left)] hidden h-7 w-fit min-w-0 shrink-0 items-center overflow-hidden rounded-md tracking-tight outline-hidden ring-ring @min-[15.75rem]/sidebar-header:flex focus-visible:ring-2 [-webkit-app-region:no-drag]"
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
  );
}
