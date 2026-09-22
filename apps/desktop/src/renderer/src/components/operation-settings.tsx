import {
  type ControlStore,
  type HarnessCatalogChoice,
  type HarnessReadiness,
  type LifecycleStage,
  selectedHarnessCatalogModel,
  type WorkspaceId,
} from "@cogwork/contracts";
import { Badge } from "@cogwork/ui/components/badge";
import { Button } from "@cogwork/ui/components/button";
import { Collapsible, CollapsibleContent } from "@cogwork/ui/components/collapsible";
import { FieldDescription } from "@cogwork/ui/components/field";
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
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@cogwork/ui/components/select";
import { Separator } from "@cogwork/ui/components/separator";
import { Switch } from "@cogwork/ui/components/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@cogwork/ui/components/tooltip";
import { cn } from "@cogwork/ui/lib/utils";
import { RiArrowDownSLine, RiArrowGoBackLine } from "@remixicon/react";
import { createContext, type ReactNode, use, useState } from "react";
import {
  type AvailableHarnessCatalog,
  catalogChoiceLabel,
  catalogFor,
  type DisplayedOperationSettingName,
  harnessIsDisabled,
  harnessSelectionUpdates,
  modelOptionStates,
  modelOptionsCell,
  modelOptionUpdates,
  type OperationSettingChanges,
  operationLabels,
  operationSummaries,
  operationSummaryLine,
  operations,
  policyProfileChoices,
  providerPickerCatalogs,
  type SettingCell,
  selectableHarnessCatalogs,
  settingCell,
} from "../features/operation-settings";
import { ProviderPicker } from "./provider-picker";
import { TraitsMenu } from "./traits-menu";

interface OperationSettingsState {
  readonly controlStore: ControlStore | null;
  readonly catalogs: ReadonlyArray<AvailableHarnessCatalog>;
  readonly readiness: HarnessReadiness | null;
  readonly workspace: WorkspaceId;
}

interface OperationSettingsActions {
  readonly write: (operation: LifecycleStage, updates: OperationSettingChanges) => void;
}

interface OperationSettingsMeta {
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

interface ControlLabelSpec {
  readonly label: string;
  readonly options: ReadonlyArray<HarnessCatalogChoice>;
  readonly cell: SettingCell;
  readonly reset: () => void;
}

interface ControlSpec extends ControlLabelSpec {
  readonly select: (value: string) => void;
}

/** A catalog value's label, so an inherited harness reads "Codex" rather than "codex". */
const labelOf = (spec: ControlLabelSpec, value: string | null) => catalogChoiceLabel(spec.options, value);

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
function RevertLabel({ spec, label }: { readonly spec: ControlLabelSpec; readonly label: string }) {
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
    state: { catalogs, controlStore, readiness, workspace },
    actions: { write },
    meta: { disabled },
  } = useOperationSettings();
  const cell = (setting: DisplayedOperationSettingName) =>
    settingCell(controlStore, catalogs, workspace, operation, setting);
  const harnessCell = cell("harness");
  const catalog = catalogFor(catalogs, harnessCell.effective);
  const pickerCatalogs = providerPickerCatalogs(catalogs, readiness);
  const pickerProviders = selectableHarnessCatalogs(controlStore, pickerCatalogs);
  const set = (setting: DisplayedOperationSettingName, value: string | null) =>
    write(operation, [{ setting, value }]);
  const applyHarnessSelection = (harness: string | null, model: string | null) => {
    write(operation, harnessSelectionUpdates(harnessCell.effective, harness, model));
  };
  const resetHarnessAndModel = () => applyHarnessSelection(null, null);
  const modelCell = cell("model");
  const model = catalog ? selectedHarnessCatalogModel(catalog.models, modelCell.effective) : undefined;
  const traits = model ? modelOptionStates(model, modelOptionsCell(controlStore, workspace, operation)) : [];
  const hasTraits = catalog !== null && model !== undefined;
  const pairOwn = modelCell.own ?? harnessCell.own;
  const profileChoices = catalog ? policyProfileChoices(catalog) : [];
  const profileSpec: ControlSpec | null =
    profileChoices.length > 0
      ? {
          label: "Permissions",
          options: profileChoices,
          cell: cell("permission-profile"),
          select: (value) => set("permission-profile", value),
          reset: () => set("permission-profile", null),
        }
      : null;

  const modelSpec: ControlLabelSpec = {
    label: "Model",
    options: catalog?.models ?? [],
    cell: { ...modelCell, own: pairOwn },
    reset: resetHarnessAndModel,
  };
  const selectionStale = harnessCell.stale || modelCell.stale;
  return (
    <div className="flex flex-wrap items-center gap-3">
      <RevertLabel spec={modelSpec} label="Model" />
      <ProviderPicker.Provider
        value={{
          state: {
            allProviders: pickerCatalogs,
            selectableProviders: pickerProviders,
            selectedHarness: harnessCell.effective,
            model: modelCell.effective,
            options: traits,
            own: pairOwn !== null,
            stale: selectionStale,
            disabledHarness: harnessIsDisabled(controlStore, harnessCell.effective),
          },
          actions: { pick: applyHarnessSelection },
          meta: { disabled },
        }}
      >
        <ProviderPicker.Root>
          <ProviderPicker.Trigger />
          <ProviderPicker.Content>
            <ProviderPicker.Rail />
            <Separator orientation="vertical" />
            <ProviderPicker.Models />
          </ProviderPicker.Content>
        </ProviderPicker.Root>
      </ProviderPicker.Provider>
      {hasTraits ? (
        <TraitsMenu
          state={{ catalog, model, options: traits }}
          actions={{ select: (options) => write(operation, modelOptionUpdates(model, options)) }}
          meta={{ disabled }}
        />
      ) : null}
      {profileSpec ? (
        <>
          <RevertLabel spec={profileSpec} label={profileSpec.label} />
          <BadgedControl spec={profileSpec} />
        </>
      ) : null}
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
      onCheckedChange={(next) => write(operation, [{ setting: "enabled", value: next ? "true" : "false" }])}
    />
  );
}

const ownSettings = ["harness", "model", "permission-profile"] as const;

function OperationRow({ operation }: { readonly operation: LifecycleStage }) {
  const {
    state: { catalogs, controlStore, workspace },
  } = useOperationSettings();
  const own = ownSettings.filter(
    (setting) => settingCell(controlStore, catalogs, workspace, operation, setting).own !== null,
  ).length;
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
