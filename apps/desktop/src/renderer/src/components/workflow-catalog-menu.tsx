import { Badge } from "@cogwork/ui/components/badge";
import { GithubIcon, LinearIcon } from "@cogwork/ui/components/brand-icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuEmpty,
  DropdownMenuFilter,
  DropdownMenuGroup,
  DropdownMenuInput,
  DropdownMenuItem,
  DropdownMenuList,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@cogwork/ui/components/dropdown-menu";
import { cn } from "@cogwork/ui/lib/utils";
import {
  RiCalendarScheduleLine,
  RiMicLine,
  RiNodeTree,
  RiRobot2Line,
  RiSlackLine,
  RiWebhookLine,
} from "@remixicon/react";
import { type ComponentType, createContext, type ReactNode, use, useState } from "react";
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

interface CatalogMenuContextValue {
  readonly state: { readonly query: string };
  readonly actions: { readonly choose: (choice: CatalogChoice) => void };
  readonly meta: { readonly catalog: Catalog };
}

const CatalogMenuContext = createContext<CatalogMenuContextValue | null>(null);

const useCatalogMenu = () => {
  const value = use(CatalogMenuContext);
  if (!value) throw new Error("CatalogMenu parts need a CatalogMenu.Root");
  return value;
};

function Root({
  catalog,
  onChoose,
  children,
}: {
  readonly catalog: Catalog;
  readonly onChoose: (choice: CatalogChoice) => void;
  readonly children: ReactNode;
}) {
  const [query, setQuery] = useState("");
  return (
    <CatalogMenuContext value={{ state: { query }, actions: { choose: onChoose }, meta: { catalog } }}>
      <DropdownMenuFilter filter={null} value={query} onValueChange={setQuery} autoHighlight>
        <DropdownMenu>{children}</DropdownMenu>
      </DropdownMenuFilter>
    </CatalogMenuContext>
  );
}

function SearchResults() {
  const {
    state: { query },
    actions: { choose },
    meta: { catalog },
  } = useCatalogMenu();
  const needle = query.trim().toLowerCase();
  const results = leavesOf(catalog).filter((choice) =>
    `${choice.groupName} ${choice.itemName} ${choice.optionName ?? ""}`.toLowerCase().includes(needle),
  );
  return (
    <DropdownMenuGroup>
      {results.map((choice) => {
        const Icon = catalogIcons[choice.icon];
        return (
          <DropdownMenuItem key={choiceKey(choice)} onClick={() => choose(choice)}>
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

function CatalogEntry({ group, entry }: { readonly group: CatalogGroup; readonly entry: CatalogItem }) {
  const {
    actions: { choose },
  } = useCatalogMenu();
  if (entry.options.length === 0) {
    return (
      <DropdownMenuItem label={entry.name} onClick={() => choose(choiceOf(group, entry, null))}>
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
            onClick={() => choose(choiceOf(group, entry, option.name))}
          >
            {option.name}
          </DropdownMenuItem>
        ))}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

function ConnectorCascade() {
  const {
    meta: { catalog },
  } = useCatalogMenu();
  return (
    <DropdownMenuGroup>
      {catalog.groups.map((group) => {
        const Icon = catalogIcons[group.icon];
        return (
          <DropdownMenuSub key={group.id}>
            <DropdownMenuSubTrigger
              label={group.name}
              className={cn(!group.connected && "text-muted-foreground")}
            >
              <Icon className="text-muted-foreground" />
              <span className="flex-1 truncate">{group.name}</span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="min-w-48">
              <DropdownMenuGroup>
                {group.items.map((entry) => (
                  <CatalogEntry key={entry.id} group={group} entry={entry} />
                ))}
              </DropdownMenuGroup>
              {group.exclusive.length > 0 ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuGroup>
                    {group.exclusive.map((entry) => (
                      <CatalogEntry key={entry.id} group={group} entry={entry} />
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

function Content({ placeholder }: { readonly placeholder: string }) {
  const {
    state: { query },
  } = useCatalogMenu();
  return (
    // Picking an Action that needs text moves the cursor into its instruction; returning focus to
    // the trigger would take it back.
    <DropdownMenuContent className="w-64" finalFocus={false}>
      <DropdownMenuInput placeholder={placeholder} aria-label={placeholder} />
      <DropdownMenuEmpty>No matches</DropdownMenuEmpty>
      <DropdownMenuList>
        {query.trim().length > 0 ? <SearchResults /> : <ConnectorCascade />}
      </DropdownMenuList>
    </DropdownMenuContent>
  );
}

export const CatalogMenu = { Root, Trigger: DropdownMenuTrigger, Content };
