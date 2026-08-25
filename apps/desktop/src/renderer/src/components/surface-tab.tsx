import { Button } from "@cogwork/ui/components/button";
import { cn } from "@cogwork/ui/lib/utils";
import { RiCloseLine } from "@remixicon/react";
import type { ReactNode } from "react";

const baseClassName = "flex h-7 shrink-0 items-center gap-0.5 rounded-md text-xs";

function SurfaceTabRoot({ active, children }: { active: boolean; children: ReactNode }) {
  return (
    <div
      className={cn(
        baseClassName,
        "pl-2 pr-1",
        active
          ? "bg-accent text-foreground"
          : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
      )}
    >
      {children}
    </div>
  );
}

function SurfaceTabButton({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <Button className="min-w-0" size="xs" variant="ghost" onClick={onClick}>
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
  Root: SurfaceTabRoot,
  Button: SurfaceTabButton,
  Close: SurfaceTabClose,
};
