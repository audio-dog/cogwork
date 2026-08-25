import { Button } from "@cogwork/ui/components/button";
import { Card, CardDescription, CardFooter, CardHeader, CardTitle } from "@cogwork/ui/components/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@cogwork/ui/components/dropdown-menu";
import { RiAddLine, RiFocus2Line, RiPulseLine, RiTerminalBoxLine } from "@remixicon/react";
import type { ComponentType } from "react";
import type { Surface } from "../store/right-panel";

type ToolSurface = Exclude<Surface, { kind: "item" }>;

export const surfaceCatalog = [
  {
    id: "attention",
    surface: { kind: "attention" },
    title: "Attention",
    description: "See work that needs a decision or is ready to merge.",
    Icon: RiFocus2Line,
  },
  {
    id: "activity",
    surface: { kind: "activity" },
    title: "Activity",
    description: "Follow the raw daemon event stream.",
    Icon: RiPulseLine,
  },
  {
    id: "terminal",
    surface: { kind: "terminal" },
    title: "Terminal",
    description: "Run commands in this workspace when it is ready.",
    Icon: RiTerminalBoxLine,
  },
] as const satisfies ReadonlyArray<{
  readonly id: ToolSurface["kind"];
  readonly surface: ToolSurface;
  readonly title: string;
  readonly description: string;
  readonly Icon: ComponentType<{ className?: string }>;
}>;

const [attentionSurface, activitySurface, terminalSurface] = surfaceCatalog;

export function toolSurfaceDescriptor(surface: ToolSurface) {
  return surfaceCatalog.find((descriptor) => descriptor.surface.kind === surface.kind);
}

export function SurfaceCatalogCards({ onSelect }: { onSelect: (surface: ToolSurface) => void }) {
  return (
    <div className="grid gap-3 p-4 sm:grid-cols-2">
      <SurfaceCatalogCard descriptor={attentionSurface} onSelect={onSelect} />
      <SurfaceCatalogCard descriptor={activitySurface} onSelect={onSelect} />
      <SurfaceCatalogCard descriptor={terminalSurface} onSelect={onSelect} />
    </div>
  );
}

export function SurfaceCatalogMenu({ onSelect }: { onSelect: (surface: ToolSurface) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button aria-label="Open a surface" size="icon-sm" variant="ghost">
            <RiAddLine data-icon="inline-start" />
          </Button>
        }
      />
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuGroup>
          <SurfaceCatalogMenuItem descriptor={attentionSurface} onSelect={onSelect} />
          <SurfaceCatalogMenuItem descriptor={activitySurface} onSelect={onSelect} />
          <SurfaceCatalogMenuItem descriptor={terminalSurface} onSelect={onSelect} />
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function SurfaceCatalogCard({
  descriptor,
  onSelect,
}: {
  descriptor: (typeof surfaceCatalog)[number];
  onSelect: (surface: ToolSurface) => void;
}) {
  const { surface, title, description, Icon } = descriptor;

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Icon className="size-4" />
          {title}
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardFooter>
        <Button className="w-full" size="sm" variant="outline" onClick={() => onSelect(surface)}>
          Open {title}
        </Button>
      </CardFooter>
    </Card>
  );
}

function SurfaceCatalogMenuItem({
  descriptor,
  onSelect,
}: {
  descriptor: (typeof surfaceCatalog)[number];
  onSelect: (surface: ToolSurface) => void;
}) {
  const { surface, title, description, Icon } = descriptor;

  return (
    <DropdownMenuItem onClick={() => onSelect(surface)}>
      <Icon className="size-4" />
      <span className="flex flex-col">
        <span>{title}</span>
        <span className="text-xs text-muted-foreground">{description}</span>
      </span>
    </DropdownMenuItem>
  );
}
