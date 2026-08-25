import { Button } from "@cogwork/ui/components/button";
import { cn } from "@cogwork/ui/lib/utils";
import { RiCloseLine } from "@remixicon/react";
import type { ComponentProps, ReactNode } from "react";

const baseClassName = "flex h-7 shrink-0 items-center gap-0.5 rounded-md text-xs";

function SurfaceTabActive({ children }: { children: ReactNode }) {
  return <div className={cn(baseClassName, "bg-accent text-foreground pl-2 pr-1")}>{children}</div>;
}

function SurfaceTabInactive({ children }: { children: ReactNode }) {
  return (
    <div
      className={cn(
        baseClassName,
        "text-muted-foreground hover:bg-accent/60 hover:text-foreground pl-2 pr-1",
      )}
    >
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

function SurfaceTabClose({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button aria-label={`Close ${label}`} size="icon-xs" variant="ghost" onClick={onClick}>
      <RiCloseLine data-icon="inline-start" />
    </Button>
  );
}

export const SurfaceTab = {
  Active: SurfaceTabActive,
  Inactive: SurfaceTabInactive,
  Button: SurfaceTabButton,
  Close: SurfaceTabClose,
};
