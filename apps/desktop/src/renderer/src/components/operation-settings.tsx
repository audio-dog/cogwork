import type {
  ControlStore,
  HarnessCatalogChoice,
  LifecycleStage,
  OperationModelOption,
  OperationSettingName,
  WorkspaceId,
} from "@cogwork/contracts";
import { Badge } from "@cogwork/ui/components/badge";
import { Button } from "@cogwork/ui/components/button";
import { Collapsible, CollapsibleContent } from "@cogwork/ui/components/collapsible";
import { FieldDescription } from "@cogwork/ui/components/field";
import { Input } from "@cogwork/ui/components/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemFooter,
  ItemHeader,
  ItemTitle,
} from "@cogwork/ui/components/item";
import { Label } from "@cogwork/ui/components/label";
import { Popover, PopoverContent, PopoverTrigger } from "@cogwork/ui/components/popover";
import { ScrollArea } from "@cogwork/ui/components/scroll-area";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@cogwork/ui/components/select";
import { Switch } from "@cogwork/ui/components/switch";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@cogwork/ui/components/tooltip";
import { cn } from "@cogwork/ui/lib/utils";
import {
  RiAlertLine,
  RiArrowDownSLine,
  RiArrowGoBackLine,
  RiCheckLine,
  RiSearchLine,
} from "@remixicon/react";
import { createContext, type ReactNode, use, useState } from "react";
import {
  catalogChoiceLabel,
  catalogChoiceMatches,
  catalogFor,
  effortChoices,
  type HarnessCatalog,
  harnessIsDisabled,
  modelOptionCell,
  modelOptionControls,
  modelOptionSets,
  modelOptionsAfter,
  modelOptionsInEffect,
  operationLabels,
  operationSummaries,
  operationSummaryLine,
  operations,
  policyProfileChoices,
  type SettingCell,
  selectableHarnessCatalogs,
  settingCell,
  unavailableHarnessLabel,
} from "../features/operation-settings";
import { providerGlyph, providerLabel } from "../features/provider-presentation";
import { ProviderGlyphIcon } from "./provider-glyph";

interface OperationSettingsState {
  readonly controlStore: ControlStore | null;
  readonly catalogs: ReadonlyArray<HarnessCatalog>;
  readonly workspace: WorkspaceId;
}

interface OperationSettingsActions {
  /** Writes one setting, or clears it back onto the default when the value is null. */
  readonly write: (setting: OperationSettingName, operation: LifecycleStage, value: string | null) => void;
  readonly writeModelOptions: (
    operation: LifecycleStage,
    value: ReadonlyArray<OperationModelOption> | null,
  ) => void;
}

interface OperationSettingsMeta {
  /** True while an act is in flight, so a second change cannot race it. */
  readonly disabled: boolean;
}

export interface OperationSettingsValue {
  readonly state: OperationSettingsState;
  readonly actions: OperationSettingsActions;
  readonly meta: OperationSettingsMeta;
}

const OperationSettingsContext = createContext<OperationSettingsValue | null>(null);

function useOperationSettings() {
  const value = use(OperationSettingsContext);
  if (!value) throw new Error("Operation settings must render inside an OperationSettings.Provider");
  return value;
}

function OperationSettingsProvider({
  value,
  children,
}: {
  readonly value: OperationSettingsValue;
  readonly children: ReactNode;
}) {
  return <OperationSettingsContext value={value}>{children}</OperationSettingsContext>;
}

interface ControlSpec {
  readonly key: string;
  readonly label: string;
  readonly options: ReadonlyArray<HarnessCatalogChoice>;
  readonly cell: SettingCell;
  readonly select: (value: string) => void;
  readonly reset: () => void;
}

/** A catalog value's label, so an inherited harness reads "Codex" rather than "codex". */
const labelOf = (spec: ControlSpec, value: string | null) => catalogChoiceLabel(spec.options, value);

function HarnessRail({
  catalogs,
  active,
  onSelect,
}: {
  readonly catalogs: readonly HarnessCatalog[];
  readonly active: string;
  readonly onSelect: (harness: string) => void;
}) {
  return (
    <TooltipProvider>
      <div className="flex w-11 shrink-0 flex-col items-center gap-1 border-e border-border pe-1.5">
        {catalogs.map((catalog) => (
          <Tooltip key={catalog.harness}>
            <TooltipTrigger
              render={
                <Button
                  size="icon-sm"
                  variant={catalog.harness === active ? "secondary" : "ghost"}
                  aria-label={providerLabel(catalog.harness)}
                  aria-pressed={catalog.harness === active}
                  onClick={() => onSelect(catalog.harness)}
                />
              }
            >
              <ProviderGlyphIcon glyph={providerGlyph(catalog.harness)} />
            </TooltipTrigger>
            <TooltipContent side="left">{providerLabel(catalog.harness)}</TooltipContent>
          </Tooltip>
        ))}
      </div>
    </TooltipProvider>
  );
}

function HarnessModelPicker({
  harnessSpec,
  modelSpec,
  catalogs,
  onPick,
}: {
  readonly harnessSpec: ControlSpec;
  readonly modelSpec: ControlSpec;
  readonly catalogs: readonly HarnessCatalog[];
  readonly onPick: (harness: string, model: string) => void;
}) {
  const {
    state: { catalogs: allCatalogs, controlStore },
    meta: { disabled },
  } = useOperationSettings();
  const effectiveHarness = harnessSpec.cell.effective;
  const effectiveCatalog = catalogFor(allCatalogs, effectiveHarness);
  // Null until the rail is picked, so a live harness change still moves the popover.
  const [chosenRail, setChosenRail] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const stale = modelSpec.cell.stale || harnessSpec.cell.stale;
  const disabledHarness = harnessIsDisabled(controlStore, effectiveHarness);
  const retiredHarness = effectiveHarness !== null && effectiveCatalog === null && !disabledHarness;
  const railCatalog =
    catalogFor(catalogs, chosenRail) ?? catalogFor(catalogs, effectiveHarness) ?? catalogs[0];
  if (!railCatalog) {
    return (
      <Button variant="outline" className="w-64 justify-start gap-2" aria-label="Harness and model" disabled>
        {effectiveCatalog ? <ProviderGlyphIcon glyph={providerGlyph(effectiveCatalog.harness)} /> : null}
        <span className="truncate">
          {unavailableHarnessLabel(
            effectiveCatalog ? providerLabel(effectiveCatalog.harness) : effectiveHarness,
            disabledHarness,
          )}
        </span>
      </Button>
    );
  }
  const rail = railCatalog.harness;
  const shown = railCatalog.models.filter((model) => catalogChoiceMatches(model, query));
  const own = modelSpec.cell.own !== null;
  const modelLabel = labelOf(modelSpec, modelSpec.cell.effective);
  const harnessLabel = effectiveCatalog ? providerLabel(effectiveCatalog.harness) : effectiveHarness;
  const triggerLabel = disabledHarness ? `${harnessLabel} disabled · ${modelLabel}` : modelLabel;

  return (
    <Popover
      open={open && !disabled}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setChosenRail(null);
      }}
    >
      <PopoverTrigger
        render={
          <Button
            variant="outline"
            className={cn("w-64 justify-start gap-2", stale && "border-destructive")}
            aria-label="Harness and model"
            disabled={disabled}
          />
        }
      >
        {effectiveCatalog ? <ProviderGlyphIcon glyph={providerGlyph(effectiveCatalog.harness)} /> : null}
        {retiredHarness ? <RiAlertLine className="text-destructive" /> : null}
        <span className={cn("truncate", !own && "text-muted-foreground")}>
          {retiredHarness ? `${effectiveHarness} · no longer offered` : triggerLabel}
        </span>
        <RiArrowDownSLine className="ms-auto size-4 text-muted-foreground" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[26rem] gap-0 p-2">
        <div className="flex gap-1.5">
          <HarnessRail catalogs={catalogs} active={rail} onSelect={setChosenRail} />
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <div className="flex items-center gap-2 border-b border-border pb-1.5">
              <RiSearchLine className="size-4 shrink-0 text-muted-foreground" />
              <Input
                aria-label={`Search ${providerLabel(railCatalog.harness)} models`}
                placeholder="Search models"
                value={query}
                className="h-7 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0 dark:bg-transparent"
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            <ScrollArea className="max-h-64">
              <div className="flex flex-col">
                {shown.length === 0 ? (
                  <p className="px-2 py-6 text-center text-sm text-muted-foreground">
                    No {providerLabel(railCatalog.harness)} model matches that.
                  </p>
                ) : (
                  shown.map((model) => {
                    const chosen = model.value === modelSpec.cell.effective && rail === effectiveHarness;
                    return (
                      <Button
                        key={model.value}
                        variant="ghost"
                        className="h-auto justify-start gap-2 px-2 py-1.5 text-start"
                        onClick={() => {
                          // One pick writes harness, model and effort; a second would
                          // interrupt all three, so the list closes with the choice.
                          setOpen(false);
                          onPick(rail, model.value);
                        }}
                      >
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="truncate text-sm font-medium">{model.label}</span>
                          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                            <ProviderGlyphIcon glyph={providerGlyph(railCatalog.harness)} />
                            {providerLabel(railCatalog.harness)}
                          </span>
                        </span>
                        {chosen ? <RiCheckLine className="size-4 shrink-0" /> : null}
                      </Button>
                    );
                  })
                )}
              </div>
            </ScrollArea>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** A described list whose default option is badged, so no option means "no value". */
function BadgedControl({ spec }: { readonly spec: ControlSpec }) {
  const {
    meta: { disabled },
  } = useOperationSettings();
  const items = [
    ...spec.options.map((option) => ({ value: option.value, label: option.label })),
    ...(spec.cell.stale && spec.cell.effective
      ? [{ value: spec.cell.effective, label: `${spec.cell.effective} · no longer offered` }]
      : []),
  ];
  return (
    <Select
      items={items}
      value={spec.cell.effective}
      disabled={disabled}
      onValueChange={(next) => {
        if (typeof next === "string") spec.select(next);
      }}
    >
      <SelectTrigger
        aria-label={spec.label}
        className={cn(
          "w-36",
          spec.cell.own === null && "text-muted-foreground",
          spec.cell.stale && "border-destructive",
        )}
      >
        <SelectValue placeholder={labelOf(spec, spec.cell.inherited)} />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {items.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
              {item.value === spec.cell.inherited ? <Badge variant="ghost">Default</Badge> : null}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

/** T3 Code puts the revert glyph on the setting's label, not beside the control. */
function RevertLabel({ spec, label }: { readonly spec: ControlSpec; readonly label: string }) {
  const {
    meta: { disabled },
  } = useOperationSettings();
  return (
    <Label className="flex w-28 shrink-0 items-center gap-1 text-sm">
      {label}
      {spec.cell.own === null || disabled ? null : (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={`Reset ${spec.label} to the default`}
                onClick={spec.reset}
              />
            }
          >
            <RiArrowGoBackLine />
          </TooltipTrigger>
          <TooltipContent side="top">
            {spec.cell.inherited
              ? `Back to the default, ${labelOf(spec, spec.cell.inherited)}`
              : "Back to the default"}
          </TooltipContent>
        </Tooltip>
      )}
    </Label>
  );
}

function OperationControls({ operation }: { readonly operation: LifecycleStage }) {
  const {
    state: { catalogs, controlStore, workspace },
    actions: { write, writeModelOptions },
  } = useOperationSettings();
  const cell = (setting: OperationSettingName) =>
    settingCell(controlStore, catalogs, workspace, operation, setting);
  const catalog = catalogFor(catalogs, cell("harness").effective);
  const selectableCatalogs = selectableHarnessCatalogs(controlStore, catalogs);
  const set = (setting: OperationSettingName, value: string | null) => write(setting, operation, value);
  const clearModelParameters = () => {
    set("effort", null);
    writeModelOptions(operation, null);
  };
  // Harness, model and effort are chosen together, so they revert together — an effort left
  // behind can outlive the catalog that offered it.
  const resetHarnessAndModel = () => {
    set("harness", null);
    set("model", null);
    clearModelParameters();
  };
  const profileCell = cell("permission-profile");
  const harnessCell = cell("harness");
  const modelCell = cell("model");
  const pairOwn = modelCell.own ?? harnessCell.own;
  const effortCell = cell("effort");
  const modelEfforts = effortChoices(catalog, modelCell.effective);
  const optionSets = modelOptionSets(controlStore, workspace, operation);
  const selectedOptions = modelOptionsInEffect(catalog, modelCell.effective, optionSets);
  const optionSpecs: readonly ControlSpec[] = modelOptionControls(
    catalog,
    modelCell.effective,
    optionSets,
  ).map((option) => ({
    key: `model-options/${option.id}`,
    label: option.label,
    options: option.choices,
    cell: modelOptionCell(optionSets, option),
    select: (value) => writeModelOptions(operation, modelOptionsAfter(selectedOptions, option.id, value)),
    // The set resolves as one value, so only clearing all of it brings the inherited set back.
    // Dropping one pair would leave the Harness to pick for that option instead.
    reset: () => writeModelOptions(operation, null),
  }));
  const profileSpec: ControlSpec | null = catalog
    ? {
        key: "permission-profile",
        label: "Permissions",
        options: policyProfileChoices(catalog),
        cell: profileCell,
        select: (value) => set("permission-profile", value),
        reset: () => set("permission-profile", null),
      }
    : null;

  const specs: readonly ControlSpec[] = [
    {
      key: "harness",
      label: "Harness",
      options: selectableCatalogs.map((entry) => ({
        value: entry.harness,
        label: providerLabel(entry.harness),
      })),
      cell: { ...harnessCell, own: pairOwn },
      select: (value) => set("harness", value),
      reset: resetHarnessAndModel,
    },
    {
      key: "model",
      label: "Model",
      options: catalog?.models ?? [],
      cell: { ...modelCell, own: pairOwn },
      select: (value) => set("model", value),
      reset: resetHarnessAndModel,
    },
    // A model with no effort axis still shows the control when an effort is in effect, which
    // a parent scope can leave behind. It reads stale there, and preflight would refuse it.
    ...(modelEfforts || effortCell.effective
      ? [
          {
            key: "effort" as const,
            label: "Effort",
            options: modelEfforts ?? [],
            cell: effortCell,
            select: (value: string) => set("effort", value),
            reset: () => set("effort", null),
          },
        ]
      : []),
    ...optionSpecs,
    ...(profileSpec ? [profileSpec] : []),
  ];

  const [harnessSpec, modelSpec, ...rest] = specs;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <RevertLabel spec={modelSpec} label="Model" />
        <HarnessModelPicker
          harnessSpec={harnessSpec}
          modelSpec={modelSpec}
          catalogs={selectableCatalogs}
          onPick={(harness, model) => {
            set("harness", harness);
            set("model", model);
            clearModelParameters();
          }}
        />
      </div>
      {rest.map((spec) => (
        <div key={spec.key} className="flex items-center gap-3">
          <RevertLabel spec={spec} label={spec.label} />
          <BadgedControl spec={spec} />
        </div>
      ))}
    </div>
  );
}

function EnabledSwitch({ operation }: { readonly operation: LifecycleStage }) {
  const {
    state: { catalogs, controlStore, workspace },
    actions: { write },
    meta: { disabled },
  } = useOperationSettings();
  const cell = settingCell(controlStore, catalogs, workspace, operation, "enabled");
  const on = cell.effective === null ? true : cell.effective === "true";
  return (
    <Switch
      aria-label={`Run ${operationLabels[operation]}`}
      checked={on}
      disabled={disabled}
      onCheckedChange={(next) => write("enabled", operation, next ? "true" : "false")}
    />
  );
}

const ownSettings: readonly OperationSettingName[] = ["harness", "model", "effort", "permission-profile"];

function OperationRow({ operation }: { readonly operation: LifecycleStage }) {
  const {
    state: { catalogs, controlStore, workspace },
  } = useOperationSettings();
  const ownScalars = ownSettings.filter(
    (setting) => settingCell(controlStore, catalogs, workspace, operation, setting).own !== null,
  ).length;
  const own = ownScalars + (modelOptionSets(controlStore, workspace, operation).own ? 1 : 0);
  // An Operation that already differs from the default opens expanded, so what differs is
  // visible without a click.
  const [open, setOpen] = useState(own > 0);
  return (
    <Item className="rounded-lg">
      <ItemHeader>
        <ItemContent>
          <ItemTitle>
            {operationLabels[operation]}
            {own > 0 ? <Badge variant="secondary">Not the default</Badge> : null}
          </ItemTitle>
          <ItemDescription>
            {operationSummaryLine(controlStore, catalogs, workspace, operation)}
          </ItemDescription>
        </ItemContent>
        <ItemActions>
          <EnabledSwitch operation={operation} />
          <Button
            size="sm"
            variant="ghost"
            aria-label={`${open ? "Hide" : "Show"} ${operationLabels[operation]} settings`}
            onClick={() => setOpen(!open)}
          >
            <RiArrowDownSLine className={cn("size-4 transition-transform", open && "rotate-180")} />
          </Button>
        </ItemActions>
      </ItemHeader>
      <Collapsible open={open} onOpenChange={setOpen} className="basis-full">
        <CollapsibleContent>
          <ItemFooter className="flex-col items-stretch gap-3 pt-3">
            <FieldDescription>{operationSummaries[operation]}</FieldDescription>
            <OperationControls operation={operation} />
          </ItemFooter>
        </CollapsibleContent>
      </Collapsible>
    </Item>
  );
}

function OperationRows() {
  return (
    <>
      {operations.map((operation) => (
        <OperationRow key={operation} operation={operation} />
      ))}
    </>
  );
}

export const OperationSettings = {
  Provider: OperationSettingsProvider,
  Rows: OperationRows,
};
