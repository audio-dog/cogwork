import { Badge } from "@cogwork/ui/components/badge";
import { GithubIcon, LinearIcon } from "@cogwork/ui/components/brand-icons";
import { Button } from "@cogwork/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuEmpty,
  DropdownMenuFilter,
  DropdownMenuGroup,
  DropdownMenuInput,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuList,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@cogwork/ui/components/dropdown-menu";
import { cn } from "@cogwork/ui/lib/utils";
import {
  RiAddLine,
  RiCalendarScheduleLine,
  RiMicLine,
  RiNodeTree,
  RiRobot2Line,
  RiSlackLine,
  RiWebhookLine,
} from "@remixicon/react";
import { type ComponentType, type ReactElement, useState } from "react";
import {
  type Catalog,
  type CatalogChoice,
  type CatalogGroup,
  type CatalogIcon,
  type CatalogItem,
  choiceKey,
  choiceOf,
  leavesOf,
} from "../features/workflow-catalog";

/**
 * The catalog picker for Triggers, Actions and hand-offs. With no query it cascades — connector,
 * then event, then option — each submenu opening beside the last so the whole path stays in view.
 * Typing in the root's search field flattens the catalog to its leaves. A submenu has no field, so
 * typing there jumps to the item whose name starts with the typed text.
 */

const catalogIcons: Record<CatalogIcon, ComponentType<{ className?: string }>> = {
  schedule: RiCalendarScheduleLine,
  github: GithubIcon,
  linear: LinearIcon,
  slack: RiSlackLine,
  granola: RiMicLine,
  webhook: RiWebhookLine,
  cogwork: RiNodeTree,
  operation: RiRobot2Line,
};

export const catalogIconFor = (icon: CatalogIcon) => catalogIcons[icon];

function SearchResults({
  catalog,
  query,
  onChoose,
}: {
  readonly catalog: Catalog;
  readonly query: string;
  readonly onChoose: (choice: CatalogChoice) => void;
}) {
  const needle = query.trim().toLowerCase();
  const results = leavesOf(catalog).filter((choice) =>
    `${choice.groupName} ${choice.itemName} ${choice.optionName ?? ""}`.toLowerCase().includes(needle),
  );
  return (
    <DropdownMenuGroup>
      {results.map((choice) => {
        const Icon = catalogIcons[choice.icon];
        return (
          <DropdownMenuItem key={choiceKey(choice)} onClick={() => onChoose(choice)}>
            <Icon className="text-muted-foreground" />
            <span className="truncate">{choice.itemName}</span>
            {choice.optionName ? (
              <Badge variant="secondary" className="font-normal">
                {choice.optionName}
              </Badge>
            ) : null}
            <span className="ms-auto shrink-0 ps-3 text-xs text-muted-foreground">{choice.groupName}</span>
          </DropdownMenuItem>
        );
      })}
    </DropdownMenuGroup>
  );
}

function CatalogEntry({
  group,
  entry,
  onChoose,
}: {
  readonly group: CatalogGroup;
  readonly entry: CatalogItem;
  readonly onChoose: (choice: CatalogChoice) => void;
}) {
  if (entry.options.length === 0) {
    return (
      <DropdownMenuItem label={entry.name} onClick={() => onChoose(choiceOf(group, entry, null))}>
        {entry.name}
      </DropdownMenuItem>
    );
  }
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger label={entry.name}>{entry.name}…</DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="min-w-40">
        {entry.options.map((option) => (
          <DropdownMenuItem
            key={option.id}
            label={option.name}
            onClick={() => onChoose(choiceOf(group, entry, option.name))}
          >
            {option.name}
          </DropdownMenuItem>
        ))}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

function ConnectorCascade({
  catalog,
  onChoose,
}: {
  readonly catalog: Catalog;
  readonly onChoose: (choice: CatalogChoice) => void;
}) {
  return (
    <DropdownMenuGroup>
      {catalog.groups.map((group) => {
        const Icon = catalogIcons[group.icon];
        return (
          <DropdownMenuSub key={group.id}>
            <DropdownMenuSubTrigger label={group.name}>
              <Icon className="text-muted-foreground" />
              <span className="flex-1 truncate">{group.name}</span>
              {group.connected ? null : (
                <Badge variant="outline" className="font-normal">
                  Connect
                </Badge>
              )}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="min-w-48">
              <DropdownMenuGroup>
                {group.items.map((entry) => (
                  <CatalogEntry key={entry.id} group={group} entry={entry} onChoose={onChoose} />
                ))}
              </DropdownMenuGroup>
              {group.exclusive.length > 0 ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuGroup>
                    <DropdownMenuLabel>Only on {group.name}</DropdownMenuLabel>
                    {group.exclusive.map((entry) => (
                      <CatalogEntry key={entry.id} group={group} entry={entry} onChoose={onChoose} />
                    ))}
                  </DropdownMenuGroup>
                </>
              ) : null}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        );
      })}
    </DropdownMenuGroup>
  );
}

function CatalogMenu({
  catalog,
  placeholder,
  onChoose,
  trigger,
}: {
  readonly catalog: Catalog;
  readonly placeholder: string;
  readonly onChoose: (choice: CatalogChoice) => void;
  readonly trigger: ReactElement;
}) {
  const [query, setQuery] = useState("");
  const searching = query.trim().length > 0;
  return (
    <DropdownMenuFilter filter={null} value={query} onValueChange={setQuery} autoHighlight>
      <DropdownMenu>
        <DropdownMenuTrigger render={trigger} />
        {/* Picking an Action that needs text moves the cursor into its instruction; returning focus to the trigger would take it back. */}
        <DropdownMenuContent className="w-64" finalFocus={false}>
          <DropdownMenuInput placeholder={placeholder} aria-label={placeholder} />
          <DropdownMenuEmpty>No matches</DropdownMenuEmpty>
          <DropdownMenuList>
            {searching ? (
              <SearchResults catalog={catalog} query={query} onChoose={onChoose} />
            ) : (
              <ConnectorCascade catalog={catalog} onChoose={onChoose} />
            )}
          </DropdownMenuList>
        </DropdownMenuContent>
      </DropdownMenu>
    </DropdownMenuFilter>
  );
}

/** The small inline button that opens the catalog beside existing content. */
export function PickFromCatalog({
  catalog,
  label,
  placeholder,
  onChoose,
  className,
}: {
  readonly catalog: Catalog;
  readonly label: string;
  readonly placeholder: string;
  readonly onChoose: (choice: CatalogChoice) => void;
  readonly className?: string;
}) {
  return (
    <CatalogMenu
      catalog={catalog}
      placeholder={placeholder}
      onChoose={onChoose}
      trigger={
        <Button size="xs" variant="ghost" className={cn("font-normal text-muted-foreground", className)}>
          <RiAddLine data-icon="inline-start" />
          {label}
        </Button>
      }
    />
  );
}

/** The full-width "+ Add …" row that opens the catalog. */
export function AddFromCatalog({
  catalog,
  label,
  placeholder,
  onChoose,
}: {
  readonly catalog: Catalog;
  readonly label: string;
  readonly placeholder: string;
  readonly onChoose: (choice: CatalogChoice) => void;
}) {
  return (
    <CatalogMenu
      catalog={catalog}
      placeholder={placeholder}
      onChoose={onChoose}
      trigger={
        <Button
          variant="ghost"
          className="w-full justify-start rounded-xl bg-muted/50 py-3 font-normal text-muted-foreground hover:bg-muted"
        >
          <RiAddLine data-icon="inline-start" />
          {label}
        </Button>
      }
    />
  );
}
