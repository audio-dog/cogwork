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
      <SurfaceTab.Close label={title} onClick={() => closeSurface("attention")} />
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

  return <CatalogEntry.MenuItem icon={Icon} title={title} onClick={() => openTool("attention")} />;
}

export function AttentionSurfaceBody() {
  return <AttentionList />;
}
