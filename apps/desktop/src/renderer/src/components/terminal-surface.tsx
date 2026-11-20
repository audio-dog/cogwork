import { DropdownMenuItem } from "@cogwork/ui/components/dropdown-menu";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@cogwork/ui/components/empty";
import { RiTerminalBoxLine } from "@remixicon/react";

import { useRightPanelStore } from "../store/right-panel";
import { CatalogEntry } from "./catalog-entry";
import { SurfaceTab } from "./surface-tab";

const title = "Terminal";
const description = "Run commands in this workspace.";
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
      <SurfaceTab.Close aria-label={`Close ${title}`} onClick={() => closeSurface("terminal")} />
    </Tab>
  );
}

export function TerminalCatalogCard() {
  const openTool = useRightPanelStore((state) => state.openTool);

  return (
    <CatalogEntry.Card onClick={() => openTool("terminal")}>
      <CatalogEntry.Media>
        <Icon />
      </CatalogEntry.Media>
      <CatalogEntry.Title>{title}</CatalogEntry.Title>
      <CatalogEntry.Description>{description}</CatalogEntry.Description>
    </CatalogEntry.Card>
  );
}

export function TerminalCatalogMenuItem() {
  const openTool = useRightPanelStore((state) => state.openTool);

  return (
    <DropdownMenuItem onClick={() => openTool("terminal")}>
      <Icon />
      {title}
    </DropdownMenuItem>
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
