import { Button } from "@cogwork/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuTrigger,
} from "@cogwork/ui/components/dropdown-menu";
import { RiAddLine } from "@remixicon/react";

import { ActivityCatalogCard, ActivityCatalogMenuItem } from "./activity-surface";
import { AttentionCatalogCard, AttentionCatalogMenuItem } from "./attention-surface";
import { TerminalCatalogCard, TerminalCatalogMenuItem } from "./terminal-surface";

export function SurfaceCatalogCards() {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <AttentionCatalogCard />
      <ActivityCatalogCard />
      <TerminalCatalogCard />
    </div>
  );
}

export function SurfaceCatalogMenu() {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button aria-label="Open a surface" size="icon-sm" variant="ghost">
            <RiAddLine data-icon="inline-start" />
          </Button>
        }
      />
      <DropdownMenuContent align="start">
        <DropdownMenuGroup>
          <AttentionCatalogMenuItem />
          <ActivityCatalogMenuItem />
          <TerminalCatalogMenuItem />
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
