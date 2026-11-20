import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@cogwork/ui/components/empty";
import { RiFileTextLine } from "@remixicon/react";

import { authorityLabel, kindLabels, scopeCopy } from "../features/configuration-model";
import { useRightPanelStore } from "../store/right-panel";
import { useConfiguration } from "./configuration-provider";
import { SurfaceTab } from "./surface-tab";

const Icon = RiFileTextLine;

export function FileSurfaceTab({ id, title }: { id: `file:${string}`; title: string }) {
  const active = useRightPanelStore((state) => state.active === id);
  const setActive = useRightPanelStore((state) => state.setActive);
  const closeSurface = useRightPanelStore((state) => state.closeSurface);
  const Tab = active ? SurfaceTab.Active : SurfaceTab.Inactive;

  return (
    <Tab>
      <SurfaceTab.Button onClick={() => setActive(id)}>
        <Icon data-icon="inline-start" />
        <span className="truncate">{title}</span>
      </SurfaceTab.Button>
      <SurfaceTab.Close aria-label={`Close ${title}`} onClick={() => closeSurface(id)} />
    </Tab>
  );
}

function Property({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-3 py-1.5">
      <span className="w-28 shrink-0 text-xs text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1 text-xs">{value}</span>
    </div>
  );
}

export function FileSurfaceBody({ path }: { path: string }) {
  const {
    meta: { contributionByFile, workspaceById },
  } = useConfiguration();
  const contribution = contributionByFile(path);
  const workspace = workspaceById(contribution?.definedIn);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      <div className="flex flex-col gap-3 border-b p-4">
        <span className="font-mono text-xs break-all text-muted-foreground">{path}</span>
        {contribution ? (
          <div className="flex flex-col divide-y divide-border/60">
            <Property label="Name" value={contribution.localName} />
            <Property label="Kind" value={kindLabels[contribution.kind]} />
            <Property label="Description" value={contribution.summary} />
            <Property label="Author" value={authorityLabel(contribution.authority)} />
            <Property
              label="Lives in"
              value={`${workspace ? `${workspace.name} · ` : ""}${scopeCopy[contribution.definedAt].name}`}
            />
          </div>
        ) : null}
      </div>

      <Empty className="flex-1 py-16">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Icon />
          </EmptyMedia>
          <EmptyTitle>No preview yet</EmptyTitle>
          <EmptyDescription>You'll be able to read files here soon.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    </div>
  );
}
