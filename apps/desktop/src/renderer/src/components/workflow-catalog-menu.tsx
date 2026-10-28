import { availabilityOf, type MachineReadiness, type WorkflowCatalogEntry } from "@cogwork/contracts";
import { Badge } from "@cogwork/ui/components/badge";
import { GithubIcon, LinearIcon } from "@cogwork/ui/components/brand-icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@cogwork/ui/components/dropdown-menu";
import {
  RiCalendarScheduleLine,
  RiMicLine,
  RiNodeTree,
  RiRobot2Line,
  RiSlackLine,
  RiWebhookLine,
} from "@remixicon/react";
import { type ComponentType, createContext, type ReactNode, use } from "react";
import type { CatalogIcon } from "../features/workflow-catalog";

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

const systemIcons: Readonly<Record<string, ComponentType<{ className?: string }>>> = catalogIcons;

const iconOf = (system: string | null) => systemIcons[system ?? ""] ?? catalogIcons.cogwork;

const appName = (system: string | null) => {
  const name = system ?? "Cogwork";
  return `${name.slice(0, 1).toUpperCase()}${name.slice(1)}`;
};

interface CatalogMenuValue {
  readonly entries: ReadonlyArray<WorkflowCatalogEntry>;
  readonly machine: MachineReadiness;
  readonly choose: (entry: WorkflowCatalogEntry) => void;
}

const CatalogMenuContext = createContext<CatalogMenuValue | null>(null);

const useCatalogMenu = () => {
  const value = use(CatalogMenuContext);
  if (!value) throw new Error("CatalogMenu parts need a CatalogMenu.Provider");
  return value;
};

function Provider({
  entries,
  machine,
  onChoose,
  children,
}: {
  readonly entries: ReadonlyArray<WorkflowCatalogEntry>;
  readonly machine: MachineReadiness;
  readonly onChoose: (entry: WorkflowCatalogEntry) => void;
  readonly children: ReactNode;
}) {
  return (
    <CatalogMenuContext value={{ entries, machine, choose: onChoose }}>
      <DropdownMenu>{children}</DropdownMenu>
    </CatalogMenuContext>
  );
}

function Entry({ entry }: { readonly entry: WorkflowCatalogEntry }) {
  const { machine, choose } = useCatalogMenu();
  const availability = availabilityOf(entry, machine);
  const disabled = availability._tag === "Unavailable";
  const status = {
    Available: null,
    ConnectionNeeded: "Connect",
    Unavailable: availability._tag === "Unavailable" ? availability.reason : null,
  }[availability._tag];
  return (
    <DropdownMenuItem disabled={disabled} label={entry.name} onClick={() => choose(entry)}>
      <span className="flex-1 truncate">{entry.name}</span>
      {entry.requires.length > 0 ? (
        <Badge variant="outline">Requires {entry.requires.join(", ")}</Badge>
      ) : null}
      {status ? <Badge variant="secondary">{status}</Badge> : null}
    </DropdownMenuItem>
  );
}

function Content() {
  const { entries } = useCatalogMenu();
  const systems = [...new Set(entries.map(({ system }) => system))];
  return (
    <DropdownMenuContent className="min-w-64">
      <DropdownMenuGroup>
        {systems.map((system) => {
          const Icon = iconOf(system);
          return (
            <DropdownMenuSub key={system ?? "cogwork"}>
              <DropdownMenuSubTrigger label={appName(system)}>
                <Icon className="text-muted-foreground" />
                {appName(system)}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="min-w-72">
                <DropdownMenuGroup>
                  {entries
                    .filter((entry) => entry.system === system)
                    .map((entry) => (
                      <Entry key={entry.key} entry={entry} />
                    ))}
                </DropdownMenuGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          );
        })}
      </DropdownMenuGroup>
    </DropdownMenuContent>
  );
}

export const CatalogMenu = { Provider, Trigger: DropdownMenuTrigger, Content };
