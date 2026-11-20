import { Button } from "@cogwork/ui/components/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@cogwork/ui/components/context-menu";
import { cn } from "@cogwork/ui/lib/utils";
import { RiCloseLine } from "@remixicon/react";
import type { ComponentProps, ReactNode } from "react";

import { type RightPanelState, useRightPanelStore } from "../store/right-panel";

const baseClassName = "group/surface-tab flex h-7 shrink-0 items-center gap-0.5 rounded-md pl-2 pr-1 text-xs";

function SurfaceTabActive({ children }: { children: ReactNode }) {
  return <div className={cn(baseClassName, "bg-accent text-foreground")}>{children}</div>;
}

function SurfaceTabInactive({ children }: { children: ReactNode }) {
  return (
    <div className={cn(baseClassName, "text-muted-foreground hover:bg-accent/60 hover:text-foreground")}>
      {children}
    </div>
  );
}

function SurfaceTabButton({ className, children, ...props }: ComponentProps<typeof Button>) {
  return (
    <Button {...props} className={cn("min-w-0", className)} size="xs" variant="ghost">
      {children}
    </Button>
  );
}

function SurfaceTabClose({ className, ...props }: ComponentProps<typeof Button>) {
  return (
    <Button
      {...props}
      className={cn(
        "opacity-0 transition-none group-hover/surface-tab:opacity-100 focus-visible:opacity-100",
        className,
      )}
      size="icon-xs"
      variant="ghost"
    >
      <RiCloseLine data-icon="inline-start" />
    </Button>
  );
}

function SurfaceTabContextMenu({
  id,
  children,
}: {
  id: RightPanelState["surfaces"][number]["id"];
  children: ReactNode;
}) {
  const closeSurface = useRightPanelStore((state) => state.closeSurface);
  const closeOtherSurfaces = useRightPanelStore((state) => state.closeOtherSurfaces);
  const closeAllSurfaces = useRightPanelStore((state) => state.closeAllSurfaces);

  return (
    <ContextMenu>
      <ContextMenuTrigger>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuGroup>
          <ContextMenuItem onClick={() => closeSurface(id)}>Close</ContextMenuItem>
          <ContextMenuItem onClick={() => closeOtherSurfaces(id)}>Close others</ContextMenuItem>
          <ContextMenuItem onClick={closeAllSurfaces}>Close all</ContextMenuItem>
        </ContextMenuGroup>
      </ContextMenuContent>
    </ContextMenu>
  );
}

export const SurfaceTab = {
  Active: SurfaceTabActive,
  Inactive: SurfaceTabInactive,
  Button: SurfaceTabButton,
  Close: SurfaceTabClose,
  ContextMenu: SurfaceTabContextMenu,
};
