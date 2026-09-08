import { ToggleGroup, ToggleGroupItem } from "@cogwork/ui/components/toggle-group";
import { cn } from "@cogwork/ui/lib/utils";
import { RiComputerLine, RiMoonLine, RiSunLine } from "@remixicon/react";
import { createFileRoute } from "@tanstack/react-router";
import type { ComponentType } from "react";
import { SettingsSection, useFocusFlash } from "../../components/settings-parts";
import { type Theme, useTheme } from "../../components/theme-provider";
import { settingEntry } from "../../features/settings-catalog";

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
        const next = THEME_TILES.find(({ value }) => value === values[0])?.value;
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

function AppearanceSettings() {
  const entry = settingEntry("theme");
  const { ref, flashing, flashKey } = useFocusFlash(entry.id);
  return (
    <SettingsSection title="Appearance">
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
    </SettingsSection>
  );
}

export const Route = createFileRoute("/settings/appearance")({
  component: AppearanceSettings,
});
