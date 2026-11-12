import {
  type ControlStore,
  type HarnessReadiness,
  selectedHarnessCatalogModel,
  type WorkspaceId,
} from "@cogwork/contracts";
import { Badge } from "@cogwork/ui/components/badge";
import { Button } from "@cogwork/ui/components/button";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemFooter,
  ItemHeader,
  ItemTitle,
} from "@cogwork/ui/components/item";
import { Label } from "@cogwork/ui/components/label";
import { Separator } from "@cogwork/ui/components/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@cogwork/ui/components/tooltip";
import { RiArrowGoBackLine } from "@remixicon/react";
import { createContext, type ReactNode, use } from "react";
import {
  type AvailableHarnessCatalog,
  catalogFor,
  harnessIsDisabled,
  harnessSelectionUpdates,
  modelOptionStates,
  modelOptionsCell,
  modelOptionUpdates,
  type OperationSettingChanges,
  operationSummaryLine,
  providerPickerCatalogs,
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

export interface OperationSettingsValue {
  readonly state: OperationSettingsState;
  readonly actions: { readonly write: (updates: OperationSettingChanges) => void };
  readonly meta: { readonly disabled: boolean };
}

const OperationSettingsContext = createContext<OperationSettingsValue | null>(null);

const useOperationSettings = () => {
  const value = use(OperationSettingsContext);
  if (!value) throw new Error("Operation settings must render inside an OperationSettings.Provider");
  return value;
};

function OperationSettingsProvider({
  value,
  children,
}: {
  readonly value: OperationSettingsValue;
  readonly children: ReactNode;
}) {
  return <OperationSettingsContext value={value}>{children}</OperationSettingsContext>;
}

function DefaultSettings() {
  const {
    state: { catalogs, controlStore, readiness, workspace },
    actions: { write },
    meta: { disabled },
  } = useOperationSettings();
  const harnessCell = settingCell(controlStore, catalogs, workspace, "harness");
  const modelCell = settingCell(controlStore, catalogs, workspace, "model");
  const catalog = catalogFor(catalogs, harnessCell.effective);
  const model = catalog ? selectedHarnessCatalogModel(catalog.models, modelCell.effective) : undefined;
  const options = model ? modelOptionStates(model, modelOptionsCell(controlStore, workspace)) : [];
  const providerCatalogs = providerPickerCatalogs(catalogs, readiness);
  const selectableProviders = selectableHarnessCatalogs(controlStore, providerCatalogs);
  const own = modelCell.own ?? harnessCell.own;
  const reset = () => write(harnessSelectionUpdates(null, null));
  const pick = (harness: string | null, selectedModel: string | null) =>
    write(harnessSelectionUpdates(harness, selectedModel));
  return (
    <Item className="rounded-lg">
      <ItemHeader>
        <ItemContent>
          <ItemTitle>
            Default
            {own ? <Badge variant="secondary">Workspace override</Badge> : null}
          </ItemTitle>
          <ItemDescription>{operationSummaryLine(controlStore, catalogs, workspace)}</ItemDescription>
        </ItemContent>
      </ItemHeader>
      <ItemFooter className="flex flex-wrap items-center gap-3">
        <Label className="flex w-28 shrink-0 items-center gap-1 text-sm">
          Model
          {own && !disabled ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label="Reset model to the default"
                    onClick={reset}
                  />
                }
              >
                <RiArrowGoBackLine />
              </TooltipTrigger>
              <TooltipContent side="top">Back to the default</TooltipContent>
            </Tooltip>
          ) : null}
        </Label>
        <ProviderPicker.Provider
          value={{
            state: {
              allProviders: providerCatalogs,
              selectableProviders,
              selectedHarness: harnessCell.effective,
              model: modelCell.effective,
              options,
              own: own !== null,
              stale: harnessCell.stale || modelCell.stale,
              disabledHarness: harnessIsDisabled(controlStore, harnessCell.effective),
            },
            actions: { pick },
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
        {catalog && model ? (
          <TraitsMenu
            state={{ catalog, model, options }}
            actions={{ select: (selections) => write(modelOptionUpdates(model, selections)) }}
            meta={{ disabled }}
          />
        ) : null}
      </ItemFooter>
    </Item>
  );
}

export const OperationSettings = {
  Provider: OperationSettingsProvider,
  Rows: DefaultSettings,
};
