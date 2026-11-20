import type { HarnessName } from "@cogwork/contracts";
import { Button } from "@cogwork/ui/components/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@cogwork/ui/components/empty";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@cogwork/ui/components/input-group";
import { Popover, PopoverContent, PopoverTrigger } from "@cogwork/ui/components/popover";
import { ScrollArea } from "@cogwork/ui/components/scroll-area";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@cogwork/ui/components/tooltip";
import { cn } from "@cogwork/ui/lib/utils";
import { RiAlertLine, RiArrowDownSLine, RiCheckLine, RiSearchLine } from "@remixicon/react";
import { createContext, type ReactNode, use, useState } from "react";

import {
  catalogChoiceLabel,
  catalogChoiceMatches,
  catalogFor,
  type ModelOptionState,
  modelOptionSummary,
  type ProviderPickerCatalog,
} from "../features/operation-settings";
import { providerGlyph, providerLabel } from "../features/provider-presentation";
import { ProviderGlyphIcon } from "./provider-glyph";

interface ProviderPickerState {
  readonly allProviders: ReadonlyArray<ProviderPickerCatalog>;
  readonly selectableProviders: ReadonlyArray<ProviderPickerCatalog>;
  readonly selectedHarness: string | null;
  readonly model: string | null;
  readonly options: ReadonlyArray<ModelOptionState>;
  readonly own: boolean;
  readonly stale: boolean;
  readonly disabledHarness: boolean;
}

interface ProviderPickerActions {
  readonly pick: (harness: HarnessName, model: string) => void;
}

interface ProviderPickerMeta {
  readonly disabled: boolean;
}

export interface ProviderPickerValue {
  readonly state: ProviderPickerState;
  readonly actions: ProviderPickerActions;
  readonly meta: ProviderPickerMeta;
}

interface ProviderPickerContextValue {
  readonly state: ProviderPickerState & {
    readonly open: boolean;
    readonly query: string;
    readonly rail: HarnessName | null;
  };
  readonly actions: ProviderPickerActions & {
    readonly setOpen: (open: boolean) => void;
    readonly setQuery: (query: string) => void;
    readonly selectRail: (harness: HarnessName) => void;
  };
  readonly meta: ProviderPickerMeta;
}

const ProviderPickerContext = createContext<ProviderPickerContextValue | null>(null);

const useProviderPicker = () => {
  const value = use(ProviderPickerContext);
  if (!value) throw new Error("Provider picker must render inside a ProviderPicker.Provider");
  return value;
};

function ProviderPickerProvider({
  value,
  children,
}: {
  readonly value: ProviderPickerValue;
  readonly children: ReactNode;
}) {
  const [open, setOpenState] = useState(false);
  const [query, setQuery] = useState("");
  const [rail, setRail] = useState<HarnessName | null>(null);
  const close = () => {
    setOpenState(false);
    setQuery("");
    setRail(null);
  };
  const setOpen = (next: boolean) => {
    if (!next) {
      close();
      return;
    }
    setOpenState(true);
  };
  const selectRail = (harness: HarnessName) => {
    setRail(harness);
    setQuery("");
  };
  const pick = (harness: HarnessName, model: string) => {
    close();
    value.actions.pick(harness, model);
  };

  return (
    <ProviderPickerContext
      value={{
        state: { ...value.state, open, query, rail },
        actions: { ...value.actions, setOpen, setQuery, selectRail, pick },
        meta: value.meta,
      }}
    >
      {children}
    </ProviderPickerContext>
  );
}

const activeProviderFrom = (state: ProviderPickerState) =>
  catalogFor(state.allProviders, state.selectedHarness);

const activeRailProviderFrom = (state: ProviderPickerContextValue["state"]) =>
  catalogFor(state.selectableProviders, state.rail) ??
  catalogFor(state.selectableProviders, state.selectedHarness) ??
  state.selectableProviders[0];

const triggerLabel = (state: ProviderPickerState) => {
  const provider = activeProviderFrom(state);
  const model = catalogChoiceLabel(provider?.models ?? [], state.model);
  const summary = modelOptionSummary(state.options);
  const selection = [model, summary].filter((part) => part.length > 0).join(" · ");
  const providerUnavailable = provider !== null && !provider.availability.pickable;
  const retiredProvider = provider === null && state.selectedHarness !== null;
  const labels = [
    { matches: state.disabledHarness, value: `${selection} · Disabled` },
    {
      matches: providerUnavailable,
      value: `${selection} · ${provider?.availability.stateLabel}`,
    },
    {
      matches: retiredProvider,
      value: `${state.selectedHarness} · no longer offered`,
    },
    { matches: true, value: selection },
  ];
  return labels.find(({ matches }) => matches)?.value ?? selection;
};

function ProviderPickerTrigger() {
  const { state, meta } = useProviderPicker();
  const provider = activeProviderFrom(state);
  const label = triggerLabel(state);
  const accessibleLabel = provider ? `${providerLabel(provider.harness)} · ${label}` : label;
  const unavailable = state.disabledHarness || (provider !== null && !provider.availability.pickable);
  const triggerDisabled = meta.disabled || state.selectableProviders.length === 0;
  return (
    <PopoverTrigger
      render={
        <Button
          variant="outline"
          className={cn("w-64 max-w-full justify-start", state.stale && "border-destructive")}
          aria-label={`Provider and model: ${accessibleLabel}`}
          disabled={triggerDisabled}
        />
      }
    >
      {provider ? (
        <ProviderGlyphIcon glyph={providerGlyph(provider.harness)} data-icon="inline-start" />
      ) : null}
      {unavailable ? <RiAlertLine data-icon="inline-start" className="text-destructive" /> : null}
      <span className={cn("truncate", !state.own && "text-muted-foreground")}>{label}</span>
      <RiArrowDownSLine data-icon="inline-end" className="ms-auto text-muted-foreground" />
    </PopoverTrigger>
  );
}

function ProviderRailTooltip({ provider }: { readonly provider: ProviderPickerCatalog }) {
  const stateLabel = provider.availability.stateLabel === "Ready" ? null : provider.availability.stateLabel;
  return (
    <TooltipContent side="left">
      <span>{providerLabel(provider.harness)}</span>
      {stateLabel ? <span>· {stateLabel}</span> : null}
      {provider.availability.reason ? <span>· {provider.availability.reason}</span> : null}
    </TooltipContent>
  );
}

function ProviderRail() {
  const {
    state,
    actions: { selectRail },
  } = useProviderPicker();
  const active = activeRailProviderFrom(state)?.harness;
  return (
    <TooltipProvider>
      <div className="flex shrink-0 flex-col items-center gap-1 pe-1.5">
        {state.selectableProviders.map((provider) => (
          <Tooltip key={provider.harness}>
            <TooltipTrigger
              render={
                <Button
                  size="icon-sm"
                  variant={provider.harness === active ? "secondary" : "ghost"}
                  className={cn(!provider.availability.pickable && "opacity-60")}
                  aria-label={providerLabel(provider.harness)}
                  aria-pressed={provider.harness === active}
                  onClick={() => selectRail(provider.harness)}
                />
              }
            >
              <ProviderGlyphIcon glyph={providerGlyph(provider.harness)} data-icon="inline-start" />
            </TooltipTrigger>
            <ProviderRailTooltip provider={provider} />
          </Tooltip>
        ))}
      </div>
    </TooltipProvider>
  );
}

function ProviderUnavailable() {
  const { state } = useProviderPicker();
  const provider = activeRailProviderFrom(state);
  if (!provider) return null;
  return (
    <Empty className="min-h-52 p-4">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <RiAlertLine />
        </EmptyMedia>
        <EmptyTitle>
          {providerLabel(provider.harness)} · {provider.availability.stateLabel}
        </EmptyTitle>
        {provider.availability.reason ? (
          <EmptyDescription>{provider.availability.reason}</EmptyDescription>
        ) : null}
      </EmptyHeader>
    </Empty>
  );
}

function ProviderSearchEmpty() {
  const { state } = useProviderPicker();
  const provider = activeRailProviderFrom(state);
  if (!provider) return null;
  return (
    <Empty className="min-h-40 p-4">
      <EmptyHeader>
        <EmptyTitle>No matching models</EmptyTitle>
        <EmptyDescription>No {providerLabel(provider.harness)} model matches that search.</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function ProviderModels() {
  const {
    state,
    actions: { pick, setQuery },
  } = useProviderPicker();
  const provider = activeRailProviderFrom(state);
  if (!provider) return null;
  const query = state.query;
  if (!provider.availability.pickable) return <ProviderUnavailable />;
  const shown = provider.models.filter((model) => catalogChoiceMatches(model, query));
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1.5">
      <InputGroup>
        <InputGroupAddon>
          <RiSearchLine />
        </InputGroupAddon>
        <InputGroupInput
          aria-label={`Search ${providerLabel(provider.harness)} models`}
          placeholder="Search models"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </InputGroup>
      <ScrollArea className="max-h-64">
        {shown.length === 0 ? (
          <ProviderSearchEmpty />
        ) : (
          <div className="flex flex-col">
            {shown.map((model) => {
              const chosen = model.value === state.model && provider.harness === state.selectedHarness;
              return (
                <Button
                  key={model.value}
                  variant="ghost"
                  className="h-auto justify-start px-2 py-1.5 text-start"
                  aria-pressed={chosen}
                  onClick={() => pick(provider.harness, model.value)}
                >
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm font-medium">{model.label}</span>
                    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <ProviderGlyphIcon glyph={providerGlyph(provider.harness)} data-icon="inline-start" />
                      {providerLabel(provider.harness)}
                    </span>
                  </span>
                  {chosen ? <RiCheckLine data-icon="inline-end" /> : null}
                </Button>
              );
            })}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}

function ProviderPickerRoot({ children }: { readonly children: ReactNode }) {
  const {
    state,
    actions: { setOpen },
    meta,
  } = useProviderPicker();
  const popoverOpen = state.open && !meta.disabled;
  return (
    <Popover open={popoverOpen} onOpenChange={setOpen}>
      {children}
    </Popover>
  );
}

function ProviderPickerContent({ children }: { readonly children: ReactNode }) {
  const { state } = useProviderPicker();
  if (!activeRailProviderFrom(state)) return null;
  return (
    <PopoverContent align="start" className="w-[28rem] gap-0 p-2">
      <div className="flex gap-1.5">{children}</div>
    </PopoverContent>
  );
}

export const ProviderPicker = {
  Provider: ProviderPickerProvider,
  Root: ProviderPickerRoot,
  Trigger: ProviderPickerTrigger,
  Content: ProviderPickerContent,
  Rail: ProviderRail,
  Models: ProviderModels,
};
