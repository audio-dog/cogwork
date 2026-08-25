import { RiPulseLine } from "@remixicon/react";
import { useRightPanelStore } from "../store/right-panel";
import { ActivityTranscript } from "./activity-transcript";
import { CatalogEntry } from "./catalog-entry";
import { SurfaceTab } from "./surface-tab";

const title = "Activity";
const description = "Watch the raw event stream.";
const Icon = RiPulseLine;

export function ActivitySurfaceTab() {
  const active = useRightPanelStore((state) => state.active === "activity");
  const setActive = useRightPanelStore((state) => state.setActive);
  const closeSurface = useRightPanelStore((state) => state.closeSurface);
  const Tab = active ? SurfaceTab.Active : SurfaceTab.Inactive;

  return (
    <Tab>
      <SurfaceTab.Lead icon={Icon} label={title} onClose={() => closeSurface("activity")} />
      <SurfaceTab.Button onClick={() => setActive("activity")}>
        <span className="truncate">{title}</span>
      </SurfaceTab.Button>
    </Tab>
  );
}

export function ActivityCatalogCard() {
  const openTool = useRightPanelStore((state) => state.openTool);

  return (
    <CatalogEntry.Card
      description={description}
      icon={Icon}
      title={title}
      onClick={() => openTool("activity")}
    />
  );
}

export function ActivityCatalogMenuItem() {
  const openTool = useRightPanelStore((state) => state.openTool);

  return (
    <CatalogEntry.MenuItem onClick={() => openTool("activity")}>
      <Icon />
      <span className="flex flex-col">
        <span>{title}</span>
        <span className="text-xs text-muted-foreground">{description}</span>
      </span>
    </CatalogEntry.MenuItem>
  );
}

export function ActivitySurfaceBody() {
  return <ActivityTranscript />;
}
