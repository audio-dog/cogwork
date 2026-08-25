import { Button } from "@cogwork/ui/components/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@cogwork/ui/components/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@cogwork/ui/components/dropdown-menu";
import { RiAddLine, RiFocus2Line, RiPulseLine, RiTerminalBoxLine } from "@remixicon/react";
import type { ComponentType } from "react";
import type { Surface } from "../store/right-panel";

type ToolSurface = Exclude<Surface, { kind: "item" }>;

export const surfaceCatalog = [
  {
    surface: { kind: "attention" },
    title: "Attention",
    description: "See work that needs a decision or is ready to merge.",
    Icon: RiFocus2Line,
  },
  {
    surface: { kind: "activity" },
    title: "Activity",
    description: "Follow the raw daemon event stream.",
    Icon: RiPulseLine,
  },
  {
    surface: { kind: "terminal" },
    title: "Terminal",
    description: "Run commands in this workspace when it is ready.",
    Icon: RiTerminalBoxLine,
  },
] as const satisfies ReadonlyArray<{
  readonly surface: ToolSurface;
  readonly title: string;
  readonly description: string;
  readonly Icon: ComponentType<{ className?: string }>;
}>;

export function toolSurfaceDescriptor(surface: ToolSurface) {
  return surfaceCatalog.find((descriptor) => descriptor.surface.kind === surface.kind);
}

export function SurfaceCatalogCards({ onSelect }: { onSelect: (surface: ToolSurface) => void }) {
  return (
    <div className="grid gap-3 p-4 sm:grid-cols-2">
      {surfaceCatalog.map(({ surface, title, description, Icon }) => (
        <Card key={surface.kind} size="sm">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Icon className="size-4" />
              {title}
            </CardTitle>
            <CardDescription>{description}</CardDescription>
          </CardHeader>
          <div className="px-3">
            <Button className="w-full" size="sm" variant="outline" onClick={() => onSelect(surface)}>
              Open {title}
            </Button>
          </div>
        </Card>
      ))}
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
        {surfaceCatalog.map(({ surface, title, description, Icon }) => (
          <DropdownMenuItem key={surface.kind} onClick={() => onSelect(surface)}>
            <Icon className="size-4" />
            <span className="flex flex-col">
              <span>{title}</span>
              <span className="text-xs text-muted-foreground">{description}</span>
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
