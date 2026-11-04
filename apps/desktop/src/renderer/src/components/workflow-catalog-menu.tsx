import {
  availabilityOf,
  type MachineReadiness,
  type WorkflowCatalogEntry,
  type WorkflowCatalogParameter,
  type WorkflowNodeId,
  type WorkflowParameterValue,
} from "@cogwork/contracts";
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
  DropdownMenuLabel,
  DropdownMenuList,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@cogwork/ui/components/dropdown-menu";
import { Spinner } from "@cogwork/ui/components/spinner";
import {
  RiCalendarScheduleLine,
  RiMicLine,
  RiNodeTree,
  RiRobot2Line,
  RiSlackLine,
  RiWebhookLine,
} from "@remixicon/react";
import { type ComponentType, createContext, type ReactNode, use, useRef, useState } from "react";
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

const appIcons: Readonly<Record<string, ComponentType<{ className?: string }>>> = catalogIcons;

const appNames: Readonly<Record<string, string>> = {
  schedule: "Schedule",
  github: "GitHub",
  linear: "Linear",
  slack: "Slack",
  granola: "Granola",
  webhook: "Webhook",
  cogwork: "Cogwork",
};

export const appOf = (entry: WorkflowCatalogEntry) => entry.system ?? entry.key.split(".")[0] ?? "cogwork";

const appName = (app: string) => appNames[app] ?? `${app.slice(0, 1).toUpperCase()}${app.slice(1)}`;

export const appIconOf = (app: string) => appIcons[app] ?? RiNodeTree;

export interface CatalogValue {
  readonly value: string;
  readonly label: string;
}

export type ListValues = (
  entry: WorkflowCatalogEntry,
  parameter: WorkflowCatalogParameter,
) => Promise<ReadonlyArray<CatalogValue>>;

export type CatalogChoice =
  | {
      readonly _tag: "Entry";
      readonly entry: WorkflowCatalogEntry;
      readonly parameters: ReadonlyArray<WorkflowParameterValue>;
    }
  | { readonly _tag: "HandOff"; readonly operation: WorkflowNodeId };

export interface HandOffTarget {
  readonly id: WorkflowNodeId;
  readonly name: string;
}

const fixedValues = (parameter: WorkflowCatalogParameter) =>
  parameter.values.map((value) => ({ value, label: value }));

/** One parameter is picked in the menu, as a cascade; an entry with more sets them on its row. */
const cascadingParameter = (entry: WorkflowCatalogEntry) =>
  entry.parameters.length === 1 ? entry.parameters[0] : undefined;

const useValues = (
  entry: WorkflowCatalogEntry,
  parameter: WorkflowCatalogParameter,
  listValues: ListValues,
  seed: ReadonlyArray<CatalogValue>,
) => {
  const [listed, setListed] = useState<ReadonlyArray<CatalogValue> | null>(
    parameter.source === "fixed" ? fixedValues(parameter) : null,
  );
  const [failed, setFailed] = useState(false);
  const load = () => {
    if (parameter.source === "fixed") return;
    listValues(entry, parameter).then(
      (values) => {
        setListed(values);
        setFailed(false);
      },
      () => setFailed(true),
    );
  };
  return {
    values: listed ?? seed,
    loading: listed === null && !failed,
    failed: listed === null && failed,
    load,
  };
};

function ValuesState({
  values,
}: {
  readonly values: {
    readonly loading: boolean;
    readonly failed: boolean;
    readonly values: ReadonlyArray<CatalogValue>;
  };
}) {
  if (values.loading) {
    return (
      <DropdownMenuLabel className="flex items-center gap-2">
        <Spinner />
        Loading
      </DropdownMenuLabel>
    );
  }
  if (values.failed) return <DropdownMenuLabel>Could not load options</DropdownMenuLabel>;
  if (values.values.length === 0) return <DropdownMenuLabel>No options</DropdownMenuLabel>;
  return null;
}

interface CatalogMenuValue {
  readonly state: { readonly entries: ReadonlyArray<WorkflowCatalogEntry>; readonly query: string };
  readonly actions: {
    readonly choose: (choice: CatalogChoice) => void;
    readonly takeFinalFocus: () => boolean;
  };
  readonly meta: {
    readonly machine: MachineReadiness;
    readonly handOffs: ReadonlyArray<HandOffTarget>;
    readonly listValues: ListValues;
  };
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
  handOffs = [],
  listValues,
  onChoose,
  children,
}: {
  readonly entries: ReadonlyArray<WorkflowCatalogEntry>;
  readonly machine: MachineReadiness;
  readonly handOffs?: ReadonlyArray<HandOffTarget>;
  readonly listValues: ListValues;
  readonly onChoose: (choice: CatalogChoice) => void;
  readonly children: ReactNode;
}) {
  const [query, setQuery] = useState("");
  const lastPick = useRef<CatalogChoice | null>(null);
  const choose = (choice: CatalogChoice) => {
    lastPick.current = choice;
    onChoose(choice);
  };
  // A pick with agent inputs moves the cursor into its instruction; returning focus to the trigger
  // would take it back.
  const takeFinalFocus = () => {
    const pick = lastPick.current;
    lastPick.current = null;
    return pick?._tag !== "Entry" || pick.entry.agentInputs.length === 0;
  };
  return (
    <CatalogMenuContext
      value={{
        state: { entries, query },
        actions: { choose, takeFinalFocus },
        meta: { machine, handOffs, listValues },
      }}
    >
      <DropdownMenuFilter filter={null} value={query} onValueChange={setQuery} autoHighlight>
        <DropdownMenu>{children}</DropdownMenu>
      </DropdownMenuFilter>
    </CatalogMenuContext>
  );
}

const availabilityStatus = (availability: ReturnType<typeof availabilityOf>) => {
  if (availability._tag === "ConnectionNeeded") return "Connect";
  if (availability._tag === "Unavailable") return availability.reason;
  return null;
};

function useEntryAvailability(entry: WorkflowCatalogEntry) {
  const {
    meta: { machine },
  } = useCatalogMenu();
  const availability = availabilityOf(entry, machine);
  return { disabled: availability._tag === "Unavailable", status: availabilityStatus(availability) };
}

function EntryItem({ entry }: { readonly entry: WorkflowCatalogEntry }) {
  const {
    actions: { choose },
  } = useCatalogMenu();
  const { disabled, status } = useEntryAvailability(entry);
  return (
    <DropdownMenuItem
      disabled={disabled}
      label={entry.name}
      onClick={() => choose({ _tag: "Entry", entry, parameters: [] })}
    >
      <span className="flex-1 truncate">{entry.name}</span>
      {status ? <Badge variant="secondary">{status}</Badge> : null}
    </DropdownMenuItem>
  );
}

function EntryValues({
  entry,
  parameter,
}: {
  readonly entry: WorkflowCatalogEntry;
  readonly parameter: WorkflowCatalogParameter;
}) {
  const {
    actions: { choose },
    meta: { listValues },
  } = useCatalogMenu();
  const { disabled, status } = useEntryAvailability(entry);
  const values = useValues(entry, parameter, listValues, []);
  return (
    <DropdownMenuSub
      onOpenChange={(open) => {
        if (open) values.load();
      }}
    >
      <DropdownMenuSubTrigger label={entry.name} disabled={disabled}>
        <span className="flex-1 truncate">{entry.name}…</span>
        {status ? <Badge variant="secondary">{status}</Badge> : null}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="max-h-72 min-w-40">
        <DropdownMenuGroup>
          {values.values.map(({ value, label }) => (
            <DropdownMenuItem
              key={value}
              label={label}
              onClick={() => choose({ _tag: "Entry", entry, parameters: [{ id: parameter.id, value }] })}
            >
              {label}
            </DropdownMenuItem>
          ))}
          <ValuesState values={values} />
        </DropdownMenuGroup>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

function CatalogEntry({ entry }: { readonly entry: WorkflowCatalogEntry }) {
  const parameter = cascadingParameter(entry);
  if (!parameter) return <EntryItem entry={entry} />;
  return <EntryValues entry={entry} parameter={parameter} />;
}

function HandOffItems({ targets }: { readonly targets: ReadonlyArray<HandOffTarget> }) {
  const {
    actions: { choose },
  } = useCatalogMenu();
  return targets.map((target) => (
    <DropdownMenuItem
      key={target.id}
      label={target.name}
      onClick={() => choose({ _tag: "HandOff", operation: target.id })}
    >
      <RiRobot2Line className="text-muted-foreground" />
      <span className="truncate">{target.name}</span>
    </DropdownMenuItem>
  ));
}

function AppCascade() {
  const {
    state: { entries },
    meta: { handOffs },
  } = useCatalogMenu();
  const apps = [...new Set(entries.map(appOf))];
  return (
    <DropdownMenuGroup>
      {handOffs.length > 0 ? (
        <DropdownMenuSub>
          <DropdownMenuSubTrigger label="Run an Operation">
            <RiRobot2Line className="text-muted-foreground" />
            <span className="flex-1 truncate">Run an Operation</span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="min-w-48">
            <DropdownMenuGroup>
              <HandOffItems targets={handOffs} />
            </DropdownMenuGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      ) : null}
      {apps.map((app) => {
        const Icon = appIconOf(app);
        return (
          <DropdownMenuSub key={app}>
            <DropdownMenuSubTrigger label={appName(app)}>
              <Icon className="text-muted-foreground" />
              <span className="flex-1 truncate">{appName(app)}</span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="min-w-56">
              <DropdownMenuGroup>
                {entries
                  .filter((entry) => appOf(entry) === app)
                  .map((entry) => (
                    <CatalogEntry key={entry.key} entry={entry} />
                  ))}
              </DropdownMenuGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        );
      })}
    </DropdownMenuGroup>
  );
}

function SearchResult({ entry, needle }: { readonly entry: WorkflowCatalogEntry; readonly needle: string }) {
  const {
    actions: { choose },
  } = useCatalogMenu();
  const { disabled } = useEntryAvailability(entry);
  const Icon = appIconOf(appOf(entry));
  const parameter = cascadingParameter(entry);
  const values = parameter?.source === "fixed" ? fixedValues(parameter) : [];
  const haystack = `${appName(appOf(entry))} ${entry.name}`.toLowerCase();
  if (!parameter || values.length === 0) {
    if (!haystack.includes(needle)) return null;
    return <EntryItem entry={entry} />;
  }
  return values
    .filter(({ label }) => `${haystack} ${label.toLowerCase()}`.includes(needle))
    .map(({ value, label }) => (
      <DropdownMenuItem
        key={value}
        disabled={disabled}
        onClick={() => choose({ _tag: "Entry", entry, parameters: [{ id: parameter.id, value }] })}
      >
        <Icon className="text-muted-foreground" />
        <span className="truncate">{entry.name}</span>
        <Badge variant="secondary" className="font-normal">
          {label}
        </Badge>
      </DropdownMenuItem>
    ));
}

function SearchResults() {
  const {
    state: { entries, query },
    meta: { handOffs },
  } = useCatalogMenu();
  const needle = query.trim().toLowerCase();
  return (
    <DropdownMenuGroup>
      <HandOffItems targets={handOffs.filter(({ name }) => name.toLowerCase().includes(needle))} />
      {entries.map((entry) => (
        <SearchResult key={entry.key} entry={entry} needle={needle} />
      ))}
    </DropdownMenuGroup>
  );
}

function Content() {
  const {
    state: { query },
    actions: { takeFinalFocus },
  } = useCatalogMenu();
  return (
    <DropdownMenuContent className="w-64" finalFocus={takeFinalFocus}>
      <DropdownMenuInput placeholder="Search" aria-label="Search" />
      <DropdownMenuEmpty>No matches</DropdownMenuEmpty>
      <DropdownMenuList>{query.trim().length > 0 ? <SearchResults /> : <AppCascade />}</DropdownMenuList>
    </DropdownMenuContent>
  );
}

export const CatalogMenu = { Provider, Trigger: DropdownMenuTrigger, Content };

const parameterName = (parameter: WorkflowCatalogParameter) => parameter.id.replaceAll("-", " ");

/** A parameter value shown as a badge; the badge opens the values the catalog or its Connection lists. */
export function ParameterMenu({
  entry,
  parameter,
  value,
  listValues,
  onChange,
}: {
  readonly entry: WorkflowCatalogEntry;
  readonly parameter: WorkflowCatalogParameter;
  readonly value: string;
  readonly listValues: ListValues;
  readonly onChange: (value: string) => void;
}) {
  const [query, setQuery] = useState("");
  const values = useValues(entry, parameter, listValues, value ? [{ value, label: value }] : []);
  const needle = query.trim().toLowerCase();
  const shown = values.values.filter(({ label }) => label.toLowerCase().includes(needle));
  const named = entry.parameters.length > 1;
  return (
    <DropdownMenuFilter filter={null} value={query} onValueChange={setQuery}>
      <DropdownMenu
        onOpenChange={(open) => {
          if (open) values.load();
        }}
      >
        <DropdownMenuTrigger
          render={
            <Badge
              variant={value ? "secondary" : "outline"}
              className="font-normal"
              render={<button type="button" aria-label={`${entry.name} ${parameter.id}`} />}
            />
          }
        >
          {named ? <span className="text-muted-foreground">{parameterName(parameter)}</span> : null}
          {value || (named ? "…" : parameterName(parameter))}
        </DropdownMenuTrigger>
        <DropdownMenuContent className="max-h-72 w-56">
          <DropdownMenuInput placeholder="Search" aria-label={`Search ${parameterName(parameter)}`} />
          <DropdownMenuList>
            <DropdownMenuGroup>
              <DropdownMenuRadioGroup
                value={value}
                onValueChange={(next) => {
                  if (typeof next === "string") onChange(next);
                }}
              >
                {shown.map((option) => (
                  <DropdownMenuRadioItem
                    key={option.value}
                    value={option.value}
                    label={option.label}
                    closeOnClick
                  >
                    {option.label}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
              <ValuesState values={values} />
            </DropdownMenuGroup>
          </DropdownMenuList>
        </DropdownMenuContent>
      </DropdownMenu>
    </DropdownMenuFilter>
  );
}
