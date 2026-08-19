import { Card } from "@cogwork/ui/components/card";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
  InputGroupText,
} from "@cogwork/ui/components/input-group";
import { Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from "@cogwork/ui/components/item";
import { Separator } from "@cogwork/ui/components/separator";
import { Switch } from "@cogwork/ui/components/switch";
import { ToggleGroup, ToggleGroupItem } from "@cogwork/ui/components/toggle-group";
import { cn } from "@cogwork/ui/lib/utils";
import { RiAddLine, RiComputerLine, RiMoonLine, RiSubtractLine, RiSunLine } from "@remixicon/react";
import { type ComponentType, createContext, type ReactNode, use, useRef } from "react";
import {
  findSection,
  type SettingEntry,
  type SettingsSectionId,
  settingsIndex,
} from "../features/settings-catalog";
import { parseBudget, parseCount, seededValue } from "../features/settings-values";
import { useBoard } from "../features/use-board";
import { useEnginePreferences } from "../store/engine-preferences";
import { useDesktopPreferences } from "../store/preferences";
import { type Theme, useTheme } from "./theme-provider";

const DEFAULT_GLOBAL_LIMIT = 3;
const DEFAULT_PER_WORKSPACE_LIMIT = 1;
const DEFAULT_DAILY_BUDGET = 25;
const MIN_CONCURRENCY = 1;

const FocusedSettingContext = createContext<{ focus?: string; jump?: number }>({});

function useFocusFlash(id: string) {
  const { focus, jump } = use(FocusedSettingContext);
  const scrolledFor = useRef<string | undefined>(undefined);
  const flashing = focus === id;
  // Changing the key on each jump remounts the node so the CSS flash animation replays.
  const flashKey = flashing ? `${id}:${jump ?? 0}` : id;

  if (!flashing) {
    scrolledFor.current = undefined;
  }

  const ref = (node: HTMLElement | null) => {
    if (!node || !flashing || scrolledFor.current === flashKey) return;
    scrolledFor.current = flashKey;
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
  const closeToHide = useDesktopPreferences((state) => state.closeToHide);
  const setCloseToHide = useDesktopPreferences((state) => state.setCloseToHide);
  return <Switch aria-label="Close to hide" checked={closeToHide} onCheckedChange={setCloseToHide} />;
}

function NumberStepper({
  value,
  min,
  label,
  onChange,
}: {
  value: number;
  min: number;
  label: string;
  onChange: (value: number) => void;
}) {
  return (
    <InputGroup className="w-28">
      <InputGroupInput
        aria-label={label}
        inputMode="numeric"
        value={String(value)}
        onChange={(event) => onChange(parseCount(event.target.value, min))}
        className="text-center tabular-nums"
      />
      <InputGroupAddon>
        <InputGroupButton
          size="icon-xs"
          aria-label={`Decrease ${label}`}
          onClick={() => onChange(Math.max(min, value - 1))}
        >
          <RiSubtractLine />
        </InputGroupButton>
      </InputGroupAddon>
      <InputGroupAddon align="inline-end">
        <InputGroupButton size="icon-xs" aria-label={`Increase ${label}`} onClick={() => onChange(value + 1)}>
          <RiAddLine />
        </InputGroupButton>
      </InputGroupAddon>
    </InputGroup>
  );
}

function GlobalConcurrencyControl({ seed }: { seed: number | null }) {
  const override = useEnginePreferences((state) => state.globalLimit);
  const setValue = useEnginePreferences((state) => state.setGlobalLimit);
  const value = seededValue(override, seed, DEFAULT_GLOBAL_LIMIT);
  return <NumberStepper value={value} min={MIN_CONCURRENCY} label="Global concurrency" onChange={setValue} />;
}

function PerWorkspaceConcurrencyControl() {
  const override = useEnginePreferences((state) => state.perWorkspaceLimit);
  const setValue = useEnginePreferences((state) => state.setPerWorkspaceLimit);
  const value = seededValue(override, null, DEFAULT_PER_WORKSPACE_LIMIT);
  return (
    <NumberStepper
      value={value}
      min={MIN_CONCURRENCY}
      label="Per-workspace concurrency"
      onChange={setValue}
    />
  );
}

function DailyBudgetControl() {
  const override = useEnginePreferences((state) => state.dailyBudget);
  const setValue = useEnginePreferences((state) => state.setDailyBudget);
  const value = seededValue(override, null, DEFAULT_DAILY_BUDGET);
  return (
    <InputGroup className="w-36">
      <InputGroupInput
        aria-label="Daily budget"
        inputMode="numeric"
        value={String(value)}
        onChange={(event) => setValue(parseBudget(event.target.value))}
        className="tabular-nums"
      />
      <InputGroupAddon>
        <InputGroupText>$</InputGroupText>
      </InputGroupAddon>
      <InputGroupAddon align="inline-end">
        <InputGroupText>/ day</InputGroupText>
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
  return (
    <>
      <SubSectionCard label="Scheduler">
        <SettingRow entry={settingEntry("global-limit")}>
          <GlobalConcurrencyControl seed={scheduler?.globalLimit ?? null} />
        </SettingRow>
        <Separator />
        <SettingRow entry={settingEntry("per-workspace-limit")}>
          <PerWorkspaceConcurrencyControl />
        </SettingRow>
      </SubSectionCard>
      <SubSectionCard label="Budget">
        <SettingRow entry={settingEntry("daily-budget")}>
          <DailyBudgetControl />
        </SettingRow>
      </SubSectionCard>
    </>
  );
}

function SectionBody({ sectionId }: { sectionId: SettingsSectionId }) {
  switch (sectionId) {
    case "general":
      return <GeneralPage />;
    case "appearance":
      return <AppearancePage />;
    case "engine":
      return <EnginePage />;
  }
}

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
        <SectionBody sectionId={sectionId} />
      </div>
    </FocusedSettingContext>
  );
}
