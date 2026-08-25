import { Button } from "@cogwork/ui/components/button";
import { CardDescription, CardFooter, CardHeader, CardTitle } from "@cogwork/ui/components/card";
import { RiFocus2Line } from "@remixicon/react";
import { useRightPanelStore } from "../store/right-panel";
import { AttentionList } from "./attention-rail";
import { CatalogEntry } from "./catalog-entry";
import { SurfaceTab } from "./surface-tab";

const title = "Attention";
const description = "See work that needs a decision or is ready to merge.";
const Icon = RiFocus2Line;

export function AttentionSurfaceTab() {
  const active = useRightPanelStore((state) => state.active === "attention");
  const setActive = useRightPanelStore((state) => state.setActive);
  const closeSurface = useRightPanelStore((state) => state.closeSurface);

  return (
    <SurfaceTab.Root active={active}>
      <SurfaceTab.Button onClick={() => setActive("attention")}>
        <Icon data-icon="inline-start" />
        <span className="truncate">{title}</span>
      </SurfaceTab.Button>
      <SurfaceTab.Close label={title} onClick={() => closeSurface("attention")} />
    </SurfaceTab.Root>
  );
}

export function AttentionCatalogCard() {
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
        <Button className="w-full" size="sm" variant="outline" onClick={() => openTool("attention")}>
          Open {title}
        </Button>
      </CardFooter>
    </CatalogEntry.Card>
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
