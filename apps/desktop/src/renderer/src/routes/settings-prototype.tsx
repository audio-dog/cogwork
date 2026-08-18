// PROTOTYPE — throwaway. Answers wayfinder ticket #17: "what should the Settings
// experience look like?". Three radically different structural takes on the same v1
// settings (theme, close-to-hide, scheduler limits, daily budget), switchable via the
// floating bottom bar or ?variant= / arrow keys. Reachable from the account menu
// (nav-sidebar "Settings"). The winner gets rewritten properly; the losers get deleted.
//
// Assumption: each variant renders full-window (fixed inset-0) so the sidebar-takeover,
// full-page, and command-overlay shapes can each own the whole surface honestly, instead
// of sitting beside the real left sidebar. Only the settings content uses real primitives
// at real density — mutations are local stubs (theme is the one real write).
import { Button } from "@cogwork/ui/components/button";
import { Card, CardContent } from "@cogwork/ui/components/card";
import { Input } from "@cogwork/ui/components/input";
import { Separator } from "@cogwork/ui/components/separator";
import { Switch } from "@cogwork/ui/components/switch";
import {
  RiArrowLeftLine,
  RiArrowLeftSLine,
  RiArrowRightSLine,
  RiComputerLine,
  RiMoneyDollarCircleLine,
  RiMoonLine,
  RiPaletteLine,
  RiSearchLine,
  RiSpeedUpLine,
  RiSunLine,
  RiWindow2Line,
} from "@remixicon/react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import type { ComponentType } from "react";
import { useEffect, useState } from "react";
import { useTheme } from "../components/theme-provider";

const VARIANTS = ["A", "B", "C"] as const;
type Variant = (typeof VARIANTS)[number];

const VARIANT_LABEL: Record<Variant, string> = {
  A: "Sidebar takeover",
  B: "Full-page scroll",
  C: "Command overlay",
};

// --- shared settings model (stub state; theme is the one real write) ---------------

interface SettingsModel {
  theme: ReturnType<typeof useTheme>["theme"];
  setTheme: ReturnType<typeof useTheme>["setTheme"];
  closeToHide: boolean;
  setCloseToHide: (value: boolean) => void;
  globalLimit: number;
  setGlobalLimit: (value: number) => void;
  perWorkspaceLimit: number;
  setPerWorkspaceLimit: (value: number) => void;
  dailyBudget: number;
  setDailyBudget: (value: number) => void;
}

function useSettingsModel(): SettingsModel {
  const { theme, setTheme } = useTheme();
  const [closeToHide, setCloseToHide] = useState(true);
  const [globalLimit, setGlobalLimit] = useState(3);
  const [perWorkspaceLimit, setPerWorkspaceLimit] = useState(1);
  const [dailyBudget, setDailyBudget] = useState(25);
  return {
    theme,
    setTheme,
    closeToHide,
    setCloseToHide,
    globalLimit,
    setGlobalLimit,
    perWorkspaceLimit,
    setPerWorkspaceLimit,
    dailyBudget,
    setDailyBudget,
  };
}

// --- leaf controls (shared; layout is not) -----------------------------------------

function ThemeControl({ model }: { model: SettingsModel }) {
  const options = [
    { value: "system", label: "System", icon: RiComputerLine },
    { value: "light", label: "Light", icon: RiSunLine },
    { value: "dark", label: "Dark", icon: RiMoonLine },
  ] as const;
  return (
    <div className="inline-flex items-center gap-0.5 rounded-lg border p-0.5">
      {options.map((option) => (
        <Button
          key={option.value}
          size="sm"
          variant={model.theme === option.value ? "secondary" : "ghost"}
          onClick={() => model.setTheme(option.value)}
        >
          <option.icon />
          {option.label}
        </Button>
      ))}
    </div>
  );
}

function CloseToHideControl({ model }: { model: SettingsModel }) {
  return (
    <Switch aria-label="Close to hide" checked={model.closeToHide} onCheckedChange={model.setCloseToHide} />
  );
}

function NumberField({
  label,
  value,
  onChange,
  min = 0,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
}) {
  return (
    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <span>{label}</span>
      <Input
        aria-label={label}
        type="number"
        min={min}
        className="h-7 w-16 text-sm text-foreground"
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </div>
  );
}

function SchedulerControl({ model }: { model: SettingsModel }) {
  return (
    <div className="flex items-center gap-3">
      <NumberField label="Global" value={model.globalLimit} onChange={model.setGlobalLimit} min={1} />
      <NumberField
        label="Per workspace"
        value={model.perWorkspaceLimit}
        onChange={model.setPerWorkspaceLimit}
        min={1}
      />
    </div>
  );
}

function BudgetControl({ model }: { model: SettingsModel }) {
  return (
    <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
      <span>$</span>
      <Input
        type="number"
        min={0}
        className="h-7 w-24 text-sm text-foreground"
        value={model.dailyBudget}
        onChange={(event) => model.setDailyBudget(Number(event.target.value))}
      />
      <span>/ day</span>
    </div>
  );
}

// --- settings registry -------------------------------------------------------------

interface Section {
  id: string;
  label: string;
  icon: ComponentType;
}

interface SettingItem {
  id: string;
  sectionId: string;
  title: string;
  description: string;
  keywords: readonly string[];
  Control: ComponentType<{ model: SettingsModel }>;
}

const SECTIONS: readonly Section[] = [
  { id: "appearance", label: "Appearance", icon: RiPaletteLine },
  { id: "window", label: "Window", icon: RiWindow2Line },
  { id: "scheduler", label: "Scheduler", icon: RiSpeedUpLine },
  { id: "budget", label: "Budget", icon: RiMoneyDollarCircleLine },
];

const SETTINGS: readonly SettingItem[] = [
  {
    id: "theme",
    sectionId: "appearance",
    title: "Theme",
    description: "System, light, or dark appearance for the app.",
    keywords: ["theme", "appearance", "dark", "light", "color"],
    Control: ThemeControl,
  },
  {
    id: "close-to-hide",
    sectionId: "window",
    title: "Close to hide",
    description: "Closing the window hides it and leaves the engine running.",
    keywords: ["close", "hide", "window", "tray", "dock", "quit"],
    Control: CloseToHideControl,
  },
  {
    id: "scheduler-limits",
    sectionId: "scheduler",
    title: "Concurrency limits",
    description: "How many runs the scheduler keeps in flight, globally and per workspace.",
    keywords: ["scheduler", "concurrency", "limit", "in flight", "runs", "parallel"],
    Control: SchedulerControl,
  },
  {
    id: "daily-budget",
    sectionId: "budget",
    title: "Daily budget",
    description: "Spend ceiling per day before the engine pauses new work.",
    keywords: ["budget", "spend", "cost", "money", "daily", "cap"],
    Control: BudgetControl,
  },
];

function matches(item: SettingItem, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === "") return true;
  const haystack = [item.title, item.description, ...item.keywords].join(" ").toLowerCase();
  return haystack.includes(q);
}

function sectionOf(sectionId: string): Section {
  return SECTIONS.find((section) => section.id === sectionId) ?? SECTIONS[0];
}

// --- shared presentational bits ----------------------------------------------------

function SettingRow({ item, model }: { item: SettingItem; model: SettingsModel }) {
  const Control = item.Control;
  return (
    <Card size="sm">
      <CardContent className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-0.5">
          <div className="text-sm font-medium">{item.title}</div>
          <div className="text-sm text-muted-foreground">{item.description}</div>
        </div>
        <div className="shrink-0">
          <Control model={model} />
        </div>
      </CardContent>
    </Card>
  );
}

function StateReadout({ model }: { model: SettingsModel }) {
  return (
    <div className="rounded-lg border border-dashed p-3 font-mono text-xs text-muted-foreground">
      state · theme={model.theme} · closeToHide={String(model.closeToHide)} · global=
      {model.globalLimit} · perWorkspace={model.perWorkspaceLimit} · budget=${model.dailyBudget}
    </div>
  );
}

function SearchInput({
  value,
  onChange,
  placeholder,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  className?: string;
}) {
  return (
    <div className={`relative ${className ?? ""}`}>
      <RiSearchLine className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        className="pl-8"
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

// --- Variant A: sidebar takeover ---------------------------------------------------

function VariantA({ model }: { model: SettingsModel }) {
  const [query, setQuery] = useState("");
  const [activeSection, setActiveSection] = useState(SECTIONS[0].id);
  const searching = query.trim() !== "";
  const results = SETTINGS.filter((item) => matches(item, query));
  const shownSection = searching ? null : sectionOf(activeSection);
  const shownItems = searching ? results : SETTINGS.filter((item) => item.sectionId === activeSection);

  return (
    <div className="flex h-full">
      <aside className="flex w-64 shrink-0 flex-col border-r bg-sidebar">
        <div className="flex flex-col gap-2 p-3">
          <div className="px-1 text-sm font-semibold">Settings</div>
          <SearchInput value={query} onChange={setQuery} placeholder="Search settings…" />
        </div>
        <Separator />
        <nav className="flex flex-col gap-0.5 overflow-auto p-2">
          {searching ? (
            results.length === 0 ? (
              <div className="px-2 py-1.5 text-sm text-muted-foreground">No matches</div>
            ) : (
              results.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    setActiveSection(item.sectionId);
                    setQuery("");
                  }}
                  className="flex flex-col items-start rounded-md px-2 py-1.5 text-left text-sm hover:bg-sidebar-accent"
                >
                  <span>{item.title}</span>
                  <span className="text-xs text-muted-foreground">{sectionOf(item.sectionId).label}</span>
                </button>
              ))
            )
          ) : (
            SECTIONS.map((section) => {
              const Icon = section.icon;
              const active = section.id === activeSection;
              return (
                <button
                  key={section.id}
                  type="button"
                  onClick={() => setActiveSection(section.id)}
                  className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm ${
                    active ? "bg-sidebar-accent font-medium" : "hover:bg-sidebar-accent/60"
                  }`}
                >
                  <Icon />
                  <span>{section.label}</span>
                </button>
              );
            })
          )}
        </nav>
      </aside>
      <main className="min-w-0 flex-1 overflow-auto">
        <div className="mx-auto flex max-w-2xl flex-col gap-4 p-8">
          <h1 className="text-lg font-semibold">
            {searching ? `Results for “${query.trim()}”` : shownSection?.label}
          </h1>
          {shownItems.map((item) => (
            <SettingRow key={item.id} item={item} model={model} />
          ))}
          <StateReadout model={model} />
        </div>
      </main>
    </div>
  );
}

// --- Variant B: full-page scroll, search-first, no rail ----------------------------

function VariantB({ model }: { model: SettingsModel }) {
  const [query, setQuery] = useState("");
  const visibleSections = SECTIONS.filter((section) =>
    SETTINGS.some((item) => item.sectionId === section.id && matches(item, query)),
  );

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 border-b px-6 py-3">
        <SearchInput
          className="max-w-md flex-1"
          value={query}
          onChange={setQuery}
          placeholder="Search all settings…"
        />
        <div className="ml-auto flex items-center gap-1">
          {SECTIONS.map((section) => (
            <a
              key={section.id}
              href={`#section-${section.id}`}
              className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              {section.label}
            </a>
          ))}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto flex max-w-3xl flex-col gap-10 p-10">
          <div>
            <h1 className="text-2xl font-semibold">Settings</h1>
            <p className="text-sm text-muted-foreground">Everything in one scroll.</p>
          </div>
          {visibleSections.length === 0 && (
            <div className="text-sm text-muted-foreground">No settings match “{query.trim()}”.</div>
          )}
          {visibleSections.map((section) => {
            const Icon = section.icon;
            const items = SETTINGS.filter((item) => item.sectionId === section.id && matches(item, query));
            return (
              <section key={section.id} id={`section-${section.id}`} className="flex flex-col gap-3">
                <div className="flex items-center gap-2 border-b pb-2 text-sm font-semibold text-muted-foreground">
                  <Icon />
                  <span>{section.label}</span>
                </div>
                {items.map((item) => (
                  <SettingRow key={item.id} item={item} model={model} />
                ))}
              </section>
            );
          })}
          <StateReadout model={model} />
        </div>
      </div>
    </div>
  );
}

// --- Variant C: command overlay over a dimmed app ----------------------------------

function VariantC({ model }: { model: SettingsModel }) {
  const [query, setQuery] = useState("");
  const [activeSection, setActiveSection] = useState(SECTIONS[0].id);
  const searching = query.trim() !== "";
  const results = SETTINGS.filter((item) => matches(item, query));

  return (
    <div className="absolute inset-0 flex items-center justify-center bg-black/30 p-8 backdrop-blur-sm">
      <div className="flex h-[80vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border bg-popover shadow-xl">
        <div className="border-b p-2">
          <SearchInput value={query} onChange={setQuery} placeholder="Type to jump to a setting…" />
        </div>
        {searching ? (
          <div className="min-h-0 flex-1 overflow-auto p-3">
            {results.length === 0 ? (
              <div className="p-4 text-sm text-muted-foreground">No settings match “{query.trim()}”.</div>
            ) : (
              <div className="flex flex-col gap-3">
                {results.map((item) => (
                  <div key={item.id} className="flex flex-col gap-1">
                    <span className="text-xs font-medium text-muted-foreground">
                      {sectionOf(item.sectionId).label}
                    </span>
                    <SettingRow item={item} model={model} />
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="flex min-h-0 flex-1">
            <nav className="flex w-48 shrink-0 flex-col gap-0.5 overflow-auto border-r p-2">
              {SECTIONS.map((section) => {
                const Icon = section.icon;
                const active = section.id === activeSection;
                return (
                  <button
                    key={section.id}
                    type="button"
                    onClick={() => setActiveSection(section.id)}
                    className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm ${
                      active ? "bg-accent font-medium" : "hover:bg-accent/60"
                    }`}
                  >
                    <Icon />
                    <span>{section.label}</span>
                  </button>
                );
              })}
            </nav>
            <div className="min-w-0 flex-1 overflow-auto p-4">
              <div className="flex flex-col gap-3">
                <h2 className="text-sm font-semibold">{sectionOf(activeSection).label}</h2>
                {SETTINGS.filter((item) => item.sectionId === activeSection).map((item) => (
                  <SettingRow key={item.id} item={item} model={model} />
                ))}
                <StateReadout model={model} />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// --- shell: title strip + floating switcher ----------------------------------------

function isEditable(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || !!target.closest("input, textarea, select, [contenteditable='true']"))
  );
}

function PrototypeSwitcher({ variant }: { variant: Variant }) {
  const navigate = useNavigate();
  const index = VARIANTS.indexOf(variant);
  const go = (next: Variant) => navigate({ to: "/settings-prototype", search: { variant: next } });

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || isEditable(event.target)) return;
      if (event.key === "ArrowLeft") go(VARIANTS[(index - 1 + VARIANTS.length) % VARIANTS.length]);
      if (event.key === "ArrowRight") go(VARIANTS[(index + 1) % VARIANTS.length]);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index]);

  if (import.meta.env.PROD) return null;

  return (
    <div className="fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-1 rounded-full border bg-popover px-1.5 py-1 shadow-lg [-webkit-app-region:no-drag]">
      <Button
        aria-label="Previous variant"
        size="icon-sm"
        variant="ghost"
        onClick={() => go(VARIANTS[(index - 1 + VARIANTS.length) % VARIANTS.length])}
      >
        <RiArrowLeftSLine />
      </Button>
      <span className="px-2 text-xs font-medium tabular-nums">
        {variant} — {VARIANT_LABEL[variant]}
      </span>
      <Button
        aria-label="Next variant"
        size="icon-sm"
        variant="ghost"
        onClick={() => go(VARIANTS[(index + 1) % VARIANTS.length])}
      >
        <RiArrowRightSLine />
      </Button>
    </div>
  );
}

function SettingsPrototype() {
  const { variant } = Route.useSearch();
  const navigate = useNavigate();
  const model = useSettingsModel();

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-background">
      <div className="flex h-11 shrink-0 items-center border-b pr-3 pl-[var(--workspace-titlebar-content-left)] [-webkit-app-region:drag]">
        <Button
          size="sm"
          variant="ghost"
          className="[-webkit-app-region:no-drag]"
          onClick={() => navigate({ to: "/" })}
        >
          <RiArrowLeftLine />
          Back to app
        </Button>
        <span className="ml-2 text-sm text-muted-foreground">Settings prototype</span>
      </div>
      <div className="relative min-h-0 flex-1">
        {variant === "A" && <VariantA model={model} />}
        {variant === "B" && <VariantB model={model} />}
        {variant === "C" && <VariantC model={model} />}
      </div>
      <PrototypeSwitcher variant={variant} />
    </div>
  );
}

export const Route = createFileRoute("/settings-prototype")({
  validateSearch: (search: Record<string, unknown>): { variant: Variant } => {
    const value = search.variant;
    return { variant: VARIANTS.includes(value as Variant) ? (value as Variant) : "A" };
  },
  component: SettingsPrototype,
});
