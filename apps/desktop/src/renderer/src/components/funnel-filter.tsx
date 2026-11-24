import { Button } from "@cogwork/ui/components/button";
import { Checkbox } from "@cogwork/ui/components/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@cogwork/ui/components/popover";
import { Separator } from "@cogwork/ui/components/separator";
import { RiCheckLine, RiFilter3Line } from "@remixicon/react";
import { createContext, type ReactNode, use, useState } from "react";

export interface FunnelOption {
  key: string;
  label: string;
  count: number;
}

export interface FunnelFilterState {
  options: FunnelOption[];
  selected: ReadonlySet<string>;
}

export interface FunnelFilterActions {
  toggle: (key: string) => void;
  clear: () => void;
}

export interface FunnelFilterMeta {
  ariaLabel: string;
  resetLabel: string;
}

export interface FunnelFilterContextValue {
  state: FunnelFilterState;
  actions: FunnelFilterActions;
  meta: FunnelFilterMeta;
}

const FunnelFilterContext = createContext<FunnelFilterContextValue | null>(null);

function useFunnelFilterContext(part: string) {
  const value = use(FunnelFilterContext);
  if (value === null) {
    throw new Error(`FunnelFilter.${part} must render inside <FunnelFilter.Provider>.`);
  }
  return value;
}

// An empty selection is the reset state and means "all": every key passes. Both
// tabs filter their rows through this at their fold seam.
export function funnelSelectionMatches(selected: ReadonlySet<string>, key: string) {
  return selected.size === 0 || selected.has(key);
}

export function toggleFunnelKey(selected: ReadonlySet<string>, key: string) {
  const next = new Set(selected);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

export interface FunnelSelection {
  selected: ReadonlySet<string>;
  toggle: (key: string) => void;
  clear: () => void;
}

export function useFunnelSelection() {
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  return {
    selected,
    toggle: (key: string) => setSelected((current) => toggleFunnelKey(current, key)),
    clear: () => setSelected(new Set()),
  };
}

function FunnelFilterProvider({ value, children }: { value: FunnelFilterContextValue; children: ReactNode }) {
  return <FunnelFilterContext value={value}>{children}</FunnelFilterContext>;
}

function FunnelFilterControl() {
  const { state, actions, meta } = useFunnelFilterContext("Control");
  const active = state.selected.size > 0;
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button size="icon-sm" variant="ghost" aria-label={meta.ariaLabel} className="relative">
            <RiFilter3Line />
            {active && (
              <span className="absolute end-0.5 top-0.5 size-2 rounded-full bg-primary" aria-hidden />
            )}
          </Button>
        }
      />
      <PopoverContent align="end" className="w-56 p-1">
        <div className="flex flex-col gap-0.5">
          <button
            type="button"
            onClick={actions.clear}
            className="flex items-center justify-between gap-2 rounded-md px-1.5 py-1.5 text-start text-sm hover:bg-accent"
          >
            <span>{meta.resetLabel}</span>
            {state.selected.size === 0 && <RiCheckLine className="size-4 text-muted-foreground" />}
          </button>
          <Separator className="my-0.5" />
          {state.options.map((opt) => {
            const checked = state.selected.has(opt.key);
            return (
              <label
                key={opt.key}
                className="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1.5 text-sm hover:bg-accent"
              >
                <Checkbox checked={checked} onCheckedChange={() => actions.toggle(opt.key)} />
                <span className="flex-1 truncate">{opt.label}</span>
                <span className="text-xs text-muted-foreground">{opt.count}</span>
              </label>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function FunnelFilterBanner() {
  const { state, actions } = useFunnelFilterContext("Banner");
  if (state.selected.size === 0) return null;
  const names = state.options
    .filter((opt) => state.selected.has(opt.key))
    .map((opt) => opt.label)
    .join(", ");
  return (
    <div className="flex shrink-0 items-center gap-2 border-b bg-muted/30 px-3 py-1.5 text-xs text-muted-foreground">
      <RiFilter3Line className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{names}</span>
      <button type="button" onClick={actions.clear} className="shrink-0 hover:text-foreground">
        Clear
      </button>
    </div>
  );
}

export const FunnelFilter = {
  Provider: FunnelFilterProvider,
  Control: FunnelFilterControl,
  Banner: FunnelFilterBanner,
};
