import { maxSchedulerLimit } from "@cogwork/contracts";
import { Card } from "@cogwork/ui/components/card";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@cogwork/ui/components/input-group";
import { Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from "@cogwork/ui/components/item";
import { Separator } from "@cogwork/ui/components/separator";
import { Switch } from "@cogwork/ui/components/switch";
import { ToggleGroup, ToggleGroupItem } from "@cogwork/ui/components/toggle-group";
import { cn } from "@cogwork/ui/lib/utils";
import { RiAddLine, RiComputerLine, RiMoonLine, RiSubtractLine, RiSunLine } from "@remixicon/react";
import { type ComponentType, createContext, type ReactNode, use, useRef, useState } from "react";
import {
  findSection,
  type SettingEntry,
  type SettingsSectionId,
  settingsIndex,
} from "../features/settings-catalog";
import { minConcurrency, minDailyBudget, settingsOfflineFallbacks } from "../features/settings-defaults";
import { parseCount, sanitizeCountDraft } from "../features/settings-values";
import { useBoard } from "../features/use-board";
import { useSchedulerConfig } from "../features/use-scheduler-config";
import { useWindowPreferences } from "../features/use-window-preferences";
import { WorkspacesPanel } from "./configuration-workspaces-panel";
import { type Theme, useTheme } from "./theme-provider";

const FocusedSettingContext = createContext<{ focus?: string; jump?: number }>({});

function useFocusFlash(id: string) {
  const { focus, jump } = use(FocusedSettingContext);
  const flashing = focus === id;
  // Changing the key on each jump remounts the node so the CSS flash animation replays.
  const flashKey = flashing ? `${id}:${jump ?? 0}` : id;
  const scrolledNode = useRef<HTMLElement | null>(null);

  // The guard lives entirely in the ref callback (commit time) and never reads
  // or writes `ref.current` during render. Each activation remounts the keyed
  // node, so a fresh node means "scroll again": this re-scrolls when the same
  // setting + jump is focused a second time (deep-link or back), while a node
  // that stays mounted across re-renders is scrolled only once.
  const ref = (node: HTMLElement | null) => {
    if (!node || !flashing || scrolledNode.current === node) return;
    scrolledNode.current = node;
    node.scrollIntoView({ block: "center" });
  };

  return { ref, flashing, flashKey };
}

function settingEntry(id: string) {
  const found = settingsIndex.find((entry) => entry.id === id);
  if (!found) throw new Error(`Unknown setting: ${id}`);
  return found;
}

function CloseToHideControl() {
  const { preferences, setCloseToHide } = useWindowPreferences();
  return (
    <Switch
      aria-label="Close to hide"
      checked={preferences?.closeToHide ?? true}
      disabled={preferences === null}
      onCheckedChange={setCloseToHide}
    />
  );
}

function NumberStepper({
  value,
  min,
  max,
  label,
  disabled,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  label: string;
  disabled?: boolean;
  onChange: (value: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const commit = (next: number) => {
    setEditing(false);
    const clamped = Math.min(max, Math.max(min, next));
    if (clamped !== value) onChange(clamped);
  };
  return (
    <InputGroup className="w-28">
      <InputGroupInput
        aria-label={label}
        inputMode="numeric"
        disabled={disabled}
        value={editing ? draft : String(value)}
        onFocus={() => {
          setDraft(String(value));
          setEditing(true);
        }}
        onBlur={() => commit(parseCount(draft, min))}
        onChange={(event) => setDraft(sanitizeCountDraft(event.target.value))}
        className="text-center tabular-nums"
      />
      <InputGroupAddon>
        <InputGroupButton
          size="icon-xs"
          disabled={disabled}
          aria-label={`Decrease ${label}`}
          onClick={() => commit(Math.max(min, value - 1))}
        >
          <RiSubtractLine />
        </InputGroupButton>
      </InputGroupAddon>
      <InputGroupAddon align="inline-end">
        <InputGroupButton
          size="icon-xs"
          disabled={disabled}
          aria-label={`Increase ${label}`}
          onClick={() => commit(value + 1)}
        >
          <RiAddLine />
        </InputGroupButton>
      </InputGroupAddon>
    </InputGroup>
  );
}

const THEME_TILES: readonly { value: Theme; label: string; icon: ComponentType }[] = [
  { value: "system", label: "System", icon: RiComputerLine },
  { value: "light", label: "Light", icon: RiSunLine },
  { value: "dark", label: "Dark", icon: RiMoonLine },
];

// The tiles illustrate the light and dark colour schemes side by side, so they use fixed colours on
// purpose — semantic tokens would flip with the active theme and make every tile look identical.
function ThemePreview({ theme }: { theme: Theme }) {
  const light = (
    <div className="flex flex-1 flex-col gap-1 bg-white p-1.5">
      <div className="h-1.5 w-8 rounded-full bg-neutral-200" />
      <div className="h-1.5 w-10 rounded-full bg-neutral-200" />
    </div>
  );
  const dark = (
    <div className="flex flex-1 flex-col gap-1 bg-neutral-900 p-1.5">
      <div className="h-1.5 w-8 rounded-full bg-neutral-600" />
      <div className="h-1.5 w-10 rounded-full bg-neutral-700" />
    </div>
  );
  return (
    <div className="flex h-20 overflow-hidden rounded-lg border">
      {theme === "dark" ? dark : light}
      {theme === "system" && dark}
    </div>
  );
}

function ThemePicker() {
  const { theme, setTheme } = useTheme();
  return (
    <ToggleGroup
      className="grid w-full grid-cols-3 gap-3"
      value={[theme]}
      onValueChange={(values) => {
        const next = values[0] as Theme | undefined;
        if (next) setTheme(next);
      }}
    >
      {THEME_TILES.map(({ value, label, icon: Icon }) => (
        <ToggleGroupItem
          key={value}
          value={value}
          aria-label={label}
          className="h-auto w-full flex-col items-stretch gap-2 rounded-xl border border-input bg-transparent p-2 hover:bg-transparent aria-pressed:bg-transparent data-pressed:border-primary data-pressed:bg-transparent data-pressed:ring-2 data-pressed:ring-primary"
        >
          <ThemePreview theme={value} />
          <span className="flex items-center gap-1.5 px-1 pb-1 text-sm font-medium [&>svg]:size-4">
            <Icon />
            {label}
          </span>
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

function SettingRow({ entry, children }: { entry: SettingEntry; children: ReactNode }) {
  const { ref, flashing, flashKey } = useFocusFlash(entry.id);
  return (
    <Item
      key={flashKey}
      ref={ref}
      className={cn("scroll-mt-8 rounded-lg", flashing && "settings-focus-flash")}
    >
      <ItemContent>
        <ItemTitle>{entry.title}</ItemTitle>
        <ItemDescription>{entry.description}</ItemDescription>
      </ItemContent>
      <ItemActions>{children}</ItemActions>
    </Item>
  );
}

function SubSectionCard({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-medium text-muted-foreground">{label}</h2>
      <Card size="sm" className="gap-0 py-0">
        {children}
      </Card>
    </section>
  );
}

function GeneralPage() {
  return (
    <SubSectionCard label="Window">
      <SettingRow entry={settingEntry("close-to-hide")}>
        <CloseToHideControl />
      </SettingRow>
    </SubSectionCard>
  );
}

function AppearancePage() {
  const entry = settingEntry("theme");
  const { ref, flashing, flashKey } = useFocusFlash(entry.id);
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-medium text-muted-foreground">{entry.title}</h2>
      <div
        key={flashKey}
        ref={ref}
        className={cn("scroll-mt-8 rounded-xl", flashing && "settings-focus-flash")}
      >
        <ThemePicker />
      </div>
    </section>
  );
}

function EnginePage() {
  const result = useBoard();
  const scheduler = result._tag === "Success" ? result.board.scheduler : null;
  const { setConfig, result: write } = useSchedulerConfig();
  // Without a connected scheduler there is nothing real to seed from or write to, so the controls
  // show the offline fallbacks read-only until the daemon is up.
  const disabled = scheduler === null || write.waiting;
  return (
    <>
      <SubSectionCard label="Scheduler">
        <SettingRow entry={settingEntry("global-limit")}>
          <NumberStepper
            value={scheduler?.globalLimit ?? settingsOfflineFallbacks.globalConcurrency}
            min={minConcurrency}
            max={maxSchedulerLimit}
            label="Global concurrency"
            disabled={disabled}
            onChange={(globalLimit) => setConfig({ globalLimit })}
          />
        </SettingRow>
        <Separator />
        <SettingRow entry={settingEntry("per-workspace-limit")}>
          <NumberStepper
            value={scheduler?.perWorkspaceLimit ?? settingsOfflineFallbacks.perWorkspaceConcurrency}
            min={minConcurrency}
            max={maxSchedulerLimit}
            label="Per-workspace concurrency"
            disabled={disabled}
            onChange={(perWorkspaceLimit) => setConfig({ perWorkspaceLimit })}
          />
        </SettingRow>
      </SubSectionCard>
      <SubSectionCard label="Budget">
        <SettingRow entry={settingEntry("daily-budget")}>
          <NumberStepper
            value={scheduler?.dailyBudgetLimit ?? settingsOfflineFallbacks.dailyBudgetRuns}
            min={minDailyBudget}
            max={maxSchedulerLimit}
            label="Daily budget"
            disabled={disabled}
            onChange={(dailyBudget) => setConfig({ dailyBudget })}
          />
        </SettingRow>
      </SubSectionCard>
    </>
  );
}

const sectionBodyById: Record<SettingsSectionId, () => ReactNode> = {
  general: () => <GeneralPage />,
  appearance: () => <AppearancePage />,
  engine: () => <EnginePage />,
  workspaces: () => <WorkspacesPanel />,
};

export function SettingsSectionView({
  sectionId,
  focus,
  jump,
}: {
  sectionId: SettingsSectionId;
  focus?: string;
  jump?: number;
}) {
  const section = findSection(sectionId);
  return (
    <FocusedSettingContext value={{ focus, jump }}>
      <div className="flex flex-col gap-8">
        <h1 className="font-heading text-2xl font-semibold tracking-tight">{section?.label}</h1>
        {sectionBodyById[sectionId]()}
      </div>
    </FocusedSettingContext>
  );
}
