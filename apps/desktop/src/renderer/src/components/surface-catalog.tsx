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

export const surfaceCatalog = [
  {
    id: "attention",
    title: "Attention",
    description: "See work that needs a decision or is ready to merge.",
  },
  {
    id: "activity",
    title: "Activity",
    description: "Follow the raw daemon event stream.",
  },
  {
    id: "terminal",
    title: "Terminal",
    description: "Run commands in this workspace when it is ready.",
  },
] as const;

const [attentionSurface, activitySurface, terminalSurface] = surfaceCatalog;

export function SurfaceCatalogCards({
  onSelect,
}: {
  onSelect: (id: (typeof surfaceCatalog)[number]["id"]) => void;
}) {
  return (
    <div className="grid gap-3 p-4 sm:grid-cols-2">
      <Card size="sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <RiFocus2Line className="size-4" />
            {attentionSurface.title}
          </CardTitle>
          <CardDescription>{attentionSurface.description}</CardDescription>
        </CardHeader>
        <CardFooter>
          <Button className="w-full" size="sm" variant="outline" onClick={() => onSelect("attention")}>
            Open {attentionSurface.title}
          </Button>
        </CardFooter>
      </Card>
      <Card size="sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <RiPulseLine className="size-4" />
            {activitySurface.title}
          </CardTitle>
          <CardDescription>{activitySurface.description}</CardDescription>
        </CardHeader>
        <CardFooter>
          <Button className="w-full" size="sm" variant="outline" onClick={() => onSelect("activity")}>
            Open {activitySurface.title}
          </Button>
        </CardFooter>
      </Card>
      <Card size="sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <RiTerminalBoxLine className="size-4" />
            {terminalSurface.title}
          </CardTitle>
          <CardDescription>{terminalSurface.description}</CardDescription>
        </CardHeader>
        <CardFooter>
          <Button className="w-full" size="sm" variant="outline" onClick={() => onSelect("terminal")}>
            Open {terminalSurface.title}
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}

export function SurfaceCatalogMenu({
  onSelect,
}: {
  onSelect: (id: (typeof surfaceCatalog)[number]["id"]) => void;
}) {
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
          <DropdownMenuItem onClick={() => onSelect("attention")}>
            <RiFocus2Line className="size-4" />
            <span className="flex flex-col">
              <span>{attentionSurface.title}</span>
              <span className="text-xs text-muted-foreground">{attentionSurface.description}</span>
            </span>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => onSelect("activity")}>
            <RiPulseLine className="size-4" />
            <span className="flex flex-col">
              <span>{activitySurface.title}</span>
              <span className="text-xs text-muted-foreground">{activitySurface.description}</span>
            </span>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => onSelect("terminal")}>
            <RiTerminalBoxLine className="size-4" />
            <span className="flex flex-col">
              <span>{terminalSurface.title}</span>
              <span className="text-xs text-muted-foreground">{terminalSurface.description}</span>
            </span>
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
