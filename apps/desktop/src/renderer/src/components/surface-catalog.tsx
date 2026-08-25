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
import { useRightPanelStore } from "../store/right-panel";

export function SurfaceCatalogCards() {
  const openSurface = useRightPanelStore((state) => state.openSurface);

  return (
    <div className="grid gap-3 p-4 sm:grid-cols-2">
      <Card size="sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <RiFocus2Line className="size-4" />
            Attention
          </CardTitle>
          <CardDescription>See work that needs a decision or is ready to merge.</CardDescription>
        </CardHeader>
        <CardFooter>
          <Button
            className="w-full"
            size="sm"
            variant="outline"
            onClick={() => openSurface({ kind: "attention" })}
          >
            Open Attention
          </Button>
        </CardFooter>
      </Card>
      <Card size="sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <RiPulseLine className="size-4" />
            Activity
          </CardTitle>
          <CardDescription>Follow the raw daemon event stream.</CardDescription>
        </CardHeader>
        <CardFooter>
          <Button
            className="w-full"
            size="sm"
            variant="outline"
            onClick={() => openSurface({ kind: "activity" })}
          >
            Open Activity
          </Button>
        </CardFooter>
      </Card>
      <Card size="sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <RiTerminalBoxLine className="size-4" />
            Terminal
          </CardTitle>
          <CardDescription>Run commands in this workspace when it is ready.</CardDescription>
        </CardHeader>
        <CardFooter>
          <Button
            className="w-full"
            size="sm"
            variant="outline"
            onClick={() => openSurface({ kind: "terminal" })}
          >
            Open Terminal
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}

export function SurfaceCatalogMenu() {
  const openSurface = useRightPanelStore((state) => state.openSurface);

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
          <DropdownMenuItem onClick={() => openSurface({ kind: "attention" })}>
            <RiFocus2Line className="size-4" />
            <span className="flex flex-col">
              <span>Attention</span>
              <span className="text-xs text-muted-foreground">
                See work that needs a decision or is ready to merge.
              </span>
            </span>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => openSurface({ kind: "activity" })}>
            <RiPulseLine className="size-4" />
            <span className="flex flex-col">
              <span>Activity</span>
              <span className="text-xs text-muted-foreground">Follow the raw daemon event stream.</span>
            </span>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => openSurface({ kind: "terminal" })}>
            <RiTerminalBoxLine className="size-4" />
            <span className="flex flex-col">
              <span>Terminal</span>
              <span className="text-xs text-muted-foreground">
                Run commands in this workspace when it is ready.
              </span>
            </span>
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
