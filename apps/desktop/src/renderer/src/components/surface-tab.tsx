import { Button } from "@cogwork/ui/components/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@cogwork/ui/components/context-menu";
import { cn } from "@cogwork/ui/lib/utils";
import { type RemixiconComponentType, RiCloseLine } from "@remixicon/react";
import type { ComponentProps, ReactNode } from "react";
import { type RightPanelState, useRightPanelStore } from "../store/right-panel";

const baseClassName =
  "group/surface-tab flex h-7 shrink-0 items-center gap-0.5 rounded-md pl-1 pr-1.5 text-xs";

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

function SurfaceTabLead({
  icon: Icon,
  label,
  onClose,
}: {
  icon: RemixiconComponentType;
  label: string;
  onClose: () => void;
}) {
  return (
    <span className="relative flex size-5 shrink-0 items-center justify-center">
      <Icon
        aria-hidden
        className="size-3.5 group-hover/surface-tab:opacity-0 group-focus-within/surface-tab:opacity-0"
      />
      <Button
        aria-label={`Close ${label}`}
        className="absolute inset-0 size-5 opacity-0 group-hover/surface-tab:opacity-100 focus-visible:opacity-100"
        size="icon-xs"
        variant="ghost"
        onClick={onClose}
      >
        <RiCloseLine className="size-3.5" />
      </Button>
    </span>
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
  Lead: SurfaceTabLead,
  ContextMenu: SurfaceTabContextMenu,
};
