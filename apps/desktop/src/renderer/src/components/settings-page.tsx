import { Card, CardContent } from "@cogwork/ui/components/card";
import { Field, FieldContent, FieldDescription, FieldGroup, FieldTitle } from "@cogwork/ui/components/field";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@cogwork/ui/components/input-group";
import { Switch } from "@cogwork/ui/components/switch";
import { ToggleGroup, ToggleGroupItem } from "@cogwork/ui/components/toggle-group";
import { RiComputerLine, RiMoonLine, RiSunLine } from "@remixicon/react";
import { createContext, type ReactNode, use, useRef } from "react";
import {
  findSection,
  type SettingEntry,
  type SettingsSectionId,
  settingsIndex,
} from "../features/settings-catalog";
import { useDesktopPreferences } from "../store/preferences";
import { useTheme } from "./theme-provider";

const FocusedSettingContext = createContext<string | undefined>(undefined);

function settingElementId(id: string): string {
  return `setting-${id}`;
}

// Scroll the card into view once when the search box jumps to it. A ref callback keeps this out of
// an effect; the ref guards against re-scrolling on unrelated re-renders.
function useFocusScroll(id: string) {
  const focus = use(FocusedSettingContext);
  const scrolledFor = useRef<string | undefined>(undefined);
  return (node: HTMLElement | null) => {
    if (!node || focus !== id || scrolledFor.current === focus) return;
    scrolledFor.current = focus;
    node.scrollIntoView({ block: "center" });
  };
}

function SettingCard({ entry, children }: { entry: SettingEntry; children: ReactNode }) {
  const ref = useFocusScroll(entry.id);
  return (
    <Card ref={ref} id={settingElementId(entry.id)} size="sm" className="scroll-mt-6">
      <CardContent>
        <Field orientation="horizontal">
          <FieldContent>
            <FieldTitle>{entry.title}</FieldTitle>
            <FieldDescription>{entry.description}</FieldDescription>
          </FieldContent>
          {children}
        </Field>
      </CardContent>
    </Card>
  );
}

function clampInt(value: number, min: number): number {
  return Number.isNaN(value) ? min : Math.max(min, Math.trunc(value));
}

function ThemeControl() {
  const { theme, setTheme } = useTheme();
  return (
    <ToggleGroup
      variant="outline"
      value={[theme]}
      onValueChange={(value) => {
        const next = value[0];
        if (next === "system" || next === "light" || next === "dark") setTheme(next);
      }}
    >
      <ToggleGroupItem value="system" aria-label="System">
        <RiComputerLine data-icon="inline-start" />
        System
      </ToggleGroupItem>
      <ToggleGroupItem value="light" aria-label="Light">
        <RiSunLine data-icon="inline-start" />
        Light
      </ToggleGroupItem>
      <ToggleGroupItem value="dark" aria-label="Dark">
        <RiMoonLine data-icon="inline-start" />
        Dark
      </ToggleGroupItem>
    </ToggleGroup>
  );
}

function CloseToHideControl() {
  const closeToHide = useDesktopPreferences((state) => state.closeToHide);
  const setCloseToHide = useDesktopPreferences((state) => state.setCloseToHide);
  return <Switch aria-label="Close to hide" checked={closeToHide} onCheckedChange={setCloseToHide} />;
}

function SchedulerControl() {
  const globalLimit = useDesktopPreferences((state) => state.schedulerGlobalLimit);
  const perWorkspaceLimit = useDesktopPreferences((state) => state.schedulerPerWorkspaceLimit);
  const setGlobalLimit = useDesktopPreferences((state) => state.setSchedulerGlobalLimit);
  const setPerWorkspaceLimit = useDesktopPreferences((state) => state.setSchedulerPerWorkspaceLimit);
  return (
    <div className="flex items-center gap-2">
      <InputGroup className="w-36">
        <InputGroupAddon>Global</InputGroupAddon>
        <InputGroupInput
          aria-label="Global concurrency limit"
          type="number"
          min={1}
          value={globalLimit}
          onChange={(event) => setGlobalLimit(clampInt(event.target.valueAsNumber, 1))}
        />
      </InputGroup>
      <InputGroup className="w-48">
        <InputGroupAddon>Per workspace</InputGroupAddon>
        <InputGroupInput
          aria-label="Per-workspace concurrency limit"
          type="number"
          min={1}
          value={perWorkspaceLimit}
          onChange={(event) => setPerWorkspaceLimit(clampInt(event.target.valueAsNumber, 1))}
        />
      </InputGroup>
    </div>
  );
}

function BudgetControl() {
  const dailyBudget = useDesktopPreferences((state) => state.dailyBudget);
  const setDailyBudget = useDesktopPreferences((state) => state.setDailyBudget);
  return (
    <InputGroup className="w-44">
      <InputGroupAddon>$</InputGroupAddon>
      <InputGroupInput
        aria-label="Daily budget"
        type="number"
        min={0}
        value={dailyBudget}
        onChange={(event) => setDailyBudget(clampInt(event.target.valueAsNumber, 0))}
      />
      <InputGroupAddon align="inline-end">per day</InputGroupAddon>
    </InputGroup>
  );
}

function settingEntry(id: string): SettingEntry {
  const found = settingsIndex.find((item) => item.id === id);
  if (!found) throw new Error(`Unknown setting: ${id}`);
  return found;
}

function AppearancePage() {
  return (
    <FieldGroup>
      <SettingCard entry={settingEntry("theme")}>
        <ThemeControl />
      </SettingCard>
    </FieldGroup>
  );
}

function WindowPage() {
  return (
    <FieldGroup>
      <SettingCard entry={settingEntry("close-to-hide")}>
        <CloseToHideControl />
      </SettingCard>
    </FieldGroup>
  );
}

function SchedulerPage() {
  return (
    <FieldGroup>
      <SettingCard entry={settingEntry("scheduler-limits")}>
        <SchedulerControl />
      </SettingCard>
    </FieldGroup>
  );
}

function BudgetPage() {
  return (
    <FieldGroup>
      <SettingCard entry={settingEntry("daily-budget")}>
        <BudgetControl />
      </SettingCard>
    </FieldGroup>
  );
}

function SectionBody({ sectionId }: { sectionId: SettingsSectionId }) {
  switch (sectionId) {
    case "appearance":
      return <AppearancePage />;
    case "window":
      return <WindowPage />;
    case "scheduler":
      return <SchedulerPage />;
    case "budget":
      return <BudgetPage />;
  }
}

export function SettingsSectionView({ sectionId, focus }: { sectionId: SettingsSectionId; focus?: string }) {
  const section = findSection(sectionId);
  return (
    <FocusedSettingContext value={focus}>
      <div className="flex flex-col gap-6">
        <h1 className="font-heading text-lg font-semibold">{section?.label}</h1>
        <SectionBody sectionId={sectionId} />
      </div>
    </FocusedSettingContext>
  );
}
