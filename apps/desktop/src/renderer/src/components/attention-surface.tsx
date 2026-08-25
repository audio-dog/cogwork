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
      <SurfaceTab.Lead icon={Icon} label={title} onClose={() => closeSurface("attention")} />
      <SurfaceTab.Button onClick={() => setActive("attention")}>
        <span className="truncate">{title}</span>
      </SurfaceTab.Button>
    </Tab>
  );
}

export function AttentionCatalogCard() {
  const openTool = useRightPanelStore((state) => state.openTool);

  return (
    <CatalogEntry.Card
      description={description}
      icon={Icon}
      title={title}
      onClick={() => openTool("attention")}
    />
  );
}

export function AttentionCatalogMenuItem() {
  const openTool = useRightPanelStore((state) => state.openTool);

  return (
    <CatalogEntry.MenuItem onClick={() => openTool("attention")}>
      <Icon />
      <span className="flex flex-col">
        <span>{title}</span>
        <span className="text-xs text-muted-foreground">{description}</span>
      </span>
    </CatalogEntry.MenuItem>
  );
}

export function AttentionSurfaceBody() {
  return <AttentionList />;
}
