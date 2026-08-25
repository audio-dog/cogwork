import { Button } from "@cogwork/ui/components/button";
import { CardDescription, CardFooter, CardHeader, CardTitle } from "@cogwork/ui/components/card";
import { RiPulseLine } from "@remixicon/react";
import { useRightPanelStore } from "../store/right-panel";
import { ActivityTranscript } from "./activity-transcript";
import { CatalogEntry } from "./catalog-entry";
import { SurfaceTab } from "./surface-tab";

const title = "Activity";
const description = "Follow the raw daemon event stream.";
const Icon = RiPulseLine;

export function ActivitySurfaceTab() {
  const active = useRightPanelStore((state) => state.active === "activity");
  const setActive = useRightPanelStore((state) => state.setActive);
  const closeSurface = useRightPanelStore((state) => state.closeSurface);
  const Tab = active ? SurfaceTab.Active : SurfaceTab.Inactive;

  return (
    <Tab>
      <SurfaceTab.Button onClick={() => setActive("activity")}>
        <Icon data-icon="inline-start" />
        <span className="truncate">{title}</span>
      </SurfaceTab.Button>
      <SurfaceTab.Close label={title} onClick={() => closeSurface("activity")} />
    </Tab>
  );
}

export function ActivityCatalogCard() {
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
        <Button className="w-full" size="sm" variant="outline" onClick={() => openTool("activity")}>
          Open {title}
        </Button>
      </CardFooter>
    </CatalogEntry.Card>
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
