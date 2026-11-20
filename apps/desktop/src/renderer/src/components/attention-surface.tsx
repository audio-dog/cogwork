import { DropdownMenuItem } from "@cogwork/ui/components/dropdown-menu";
import { RiFocus2Line } from "@remixicon/react";

import { useRightPanelStore } from "../store/right-panel";
import { AttentionList } from "./attention-rail";
import { CatalogEntry } from "./catalog-entry";
import { SurfaceTab } from "./surface-tab";

const title = "Attention";
const description = "See what needs a decision.";
const Icon = RiFocus2Line;

export function AttentionSurfaceTab() {
  const active = useRightPanelStore((state) => state.active === "attention");
  const setActive = useRightPanelStore((state) => state.setActive);
  const closeSurface = useRightPanelStore((state) => state.closeSurface);
  const Tab = active ? SurfaceTab.Active : SurfaceTab.Inactive;

  return (
    <Tab>
      <SurfaceTab.Button onClick={() => setActive("attention")}>
        <Icon data-icon="inline-start" />
        <span className="truncate">{title}</span>
      </SurfaceTab.Button>
      <SurfaceTab.Close aria-label={`Close ${title}`} onClick={() => closeSurface("attention")} />
    </Tab>
  );
}

export function AttentionCatalogCard() {
  const openTool = useRightPanelStore((state) => state.openTool);

  return (
    <CatalogEntry.Card onClick={() => openTool("attention")}>
      <CatalogEntry.Media>
        <Icon />
      </CatalogEntry.Media>
      <CatalogEntry.Title>{title}</CatalogEntry.Title>
      <CatalogEntry.Description>{description}</CatalogEntry.Description>
    </CatalogEntry.Card>
  );
}

export function AttentionCatalogMenuItem() {
  const openTool = useRightPanelStore((state) => state.openTool);

  return (
    <DropdownMenuItem onClick={() => openTool("attention")}>
      <Icon />
      {title}
    </DropdownMenuItem>
  );
}

export function AttentionSurfaceBody() {
  return <AttentionList />;
}
