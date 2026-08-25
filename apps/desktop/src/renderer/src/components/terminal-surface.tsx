import { Button } from "@cogwork/ui/components/button";
import { CardDescription, CardFooter, CardHeader, CardTitle } from "@cogwork/ui/components/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@cogwork/ui/components/empty";
import { RiTerminalBoxLine } from "@remixicon/react";
import { useRightPanelStore } from "../store/right-panel";
import { CatalogEntry } from "./catalog-entry";
import { SurfaceTab } from "./surface-tab";

const title = "Terminal";
const description = "Run commands in this workspace when it is ready.";
const Icon = RiTerminalBoxLine;

export function TerminalSurfaceTab() {
  const active = useRightPanelStore((state) => state.active === "terminal");
  const setActive = useRightPanelStore((state) => state.setActive);
  const closeSurface = useRightPanelStore((state) => state.closeSurface);
  const Tab = active ? SurfaceTab.Active : SurfaceTab.Inactive;

  return (
    <Tab>
      <SurfaceTab.Button onClick={() => setActive("terminal")}>
        <Icon data-icon="inline-start" />
        <span className="truncate">{title}</span>
      </SurfaceTab.Button>
      <SurfaceTab.Close label={title} onClick={() => closeSurface("terminal")} />
    </Tab>
  );
}

export function TerminalCatalogCard() {
  const openTool = useRightPanelStore((state) => state.openTool);

  return (
    <CatalogEntry.Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Icon className="size-4" />
          {title}
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardFooter>
        <Button className="w-full" size="sm" variant="outline" onClick={() => openTool("terminal")}>
          Open {title}
        </Button>
      </CardFooter>
    </CatalogEntry.Card>
  );
}

export function TerminalCatalogMenuItem() {
  const openTool = useRightPanelStore((state) => state.openTool);

  return (
    <CatalogEntry.MenuItem onClick={() => openTool("terminal")}>
      <Icon />
      <span className="flex flex-col">
        <span>{title}</span>
        <span className="text-xs text-muted-foreground">{description}</span>
      </span>
    </CatalogEntry.MenuItem>
  );
}

export function TerminalSurfaceBody() {
  return (
    <Empty className="h-full border-0">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Icon />
        </EmptyMedia>
        <EmptyTitle>{title} is coming soon</EmptyTitle>
        <EmptyDescription>Terminal sessions will appear here.</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
