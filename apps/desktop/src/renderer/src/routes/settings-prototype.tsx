// PROTOTYPE — throwaway. Wayfinder #17 / build #42.
// Converged design: sidebar-takeover layout (variant A) + Codex organization
// (big category header, smaller sub-section headers over grouped divided rows) +
// T3 Code's system/light/dark preview picker for theme.
// Sidebar owns "Back to app"; no "Settings" title; no sidebar collapse toggle.
// Built from real @cogwork/ui primitives (Item, Card, ToggleGroup, InputGroup) —
// no bespoke form CSS. Reachable from the account menu → Settings.
import { Button } from "@cogwork/ui/components/button";
import { Card } from "@cogwork/ui/components/card";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
  InputGroupText,
} from "@cogwork/ui/components/input-group";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@cogwork/ui/components/item";
import { Separator } from "@cogwork/ui/components/separator";
import { Switch } from "@cogwork/ui/components/switch";
import { ToggleGroup, ToggleGroupItem } from "@cogwork/ui/components/toggle-group";
import { cn } from "@cogwork/ui/lib/utils";
import {
  RiAddLine,
  RiArrowLeftLine,
  RiCloseLine,
  RiComputerLine,
  RiMoonLine,
  RiPaletteLine,
  RiSearchLine,
  RiSettings3Line,
  RiSpeedUpLine,
  RiSubtractLine,
  RiSunLine,
} from "@remixicon/react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import type { ComponentType } from "react";
import { Fragment, useEffect, useState } from "react";
import { useTheme } from "../components/theme-provider";

type ThemeValue = "system" | "light" | "dark";

// --- settings model (stub state; theme is the one real write) ----------------------

function useSettingsModel() {
  const { theme, setTheme } = useTheme();
  const [closeToHide, setCloseToHide] = useState(true);
  const [globalLimit, setGlobalLimit] = useState(3);
  const [perWorkspaceLimit, setPerWorkspaceLimit] = useState(1);
  const [dailyBudget, setDailyBudget] = useState(25);
  return {
    theme: theme as ThemeValue,
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

type SettingsModel = ReturnType<typeof useSettingsModel>;

// --- information architecture ------------------------------------------------------

type CategoryId = "general" | "appearance" | "engine";
type RowId = "close-to-hide" | "global-limit" | "per-workspace-limit" | "daily-budget";

interface Category {
  id: CategoryId;
  label: string;
  icon: ComponentType;
}

type SubSection =
  | { kind: "rows"; id: string; label: string; rows: readonly RowId[] }
  | { kind: "theme"; id: string; label: string };

const CATEGORIES: readonly Category[] = [
  { id: "general", label: "General", icon: RiSettings3Line },
  { id: "appearance", label: "Appearance", icon: RiPaletteLine },
  { id: "engine", label: "Engine", icon: RiSpeedUpLine },
];

const SUBSECTIONS: Record<CategoryId, readonly SubSection[]> = {
  general: [{ kind: "rows", id: "window", label: "Window", rows: ["close-to-hide"] }],
  appearance: [{ kind: "theme", id: "theme", label: "Theme" }],
  engine: [
    { kind: "rows", id: "scheduler", label: "Scheduler", rows: ["global-limit", "per-workspace-limit"] },
    { kind: "rows", id: "budget", label: "Budget", rows: ["daily-budget"] },
  ],
};

interface RowMeta {
  title: string;
  description: string;
  category: CategoryId;
  keywords: readonly string[];
}

const ROWS: Record<RowId, RowMeta> = {
  "close-to-hide": {
    title: "Close to hide",
    description: "Closing the window hides it and leaves the engine running.",
    category: "general",
    keywords: ["close", "hide", "window", "tray", "menu bar", "quit"],
  },
  "global-limit": {
    title: "Global concurrency",
    description: "How many runs the scheduler keeps in flight across all workspaces.",
    category: "engine",
    keywords: ["scheduler", "concurrency", "limit", "runs", "parallel", "global"],
  },
  "per-workspace-limit": {
    title: "Per-workspace concurrency",
    description: "How many runs stay in flight inside a single workspace.",
    category: "engine",
    keywords: ["scheduler", "concurrency", "workspace", "limit", "runs"],
  },
  "daily-budget": {
    title: "Daily budget",
    description: "Spend ceiling per day before the engine pauses new work.",
    category: "engine",
    keywords: ["budget", "spend", "cost", "money", "daily", "cap"],
  },
};

const THEME_TILES: readonly { value: ThemeValue; label: string; icon: ComponentType }[] = [
  { value: "system", label: "System", icon: RiComputerLine },
  { value: "light", label: "Light", icon: RiSunLine },
  { value: "dark", label: "Dark", icon: RiMoonLine },
];

// --- search index ------------------------------------------------------------------
// Theme is a whole sub-section (the picker), not a row, so it is indexed on its own.

type SearchId = RowId | "theme";

interface SearchEntry {
  id: SearchId;
  title: string;
  category: CategoryId;
  keywords: readonly string[];
}

const SEARCH_INDEX: readonly SearchEntry[] = [
  {
    id: "theme",
    title: "Theme",
    category: "appearance",
    keywords: ["theme", "appearance", "dark", "light", "color", "scheme", "system"],
  },
  ...(Object.keys(ROWS) as RowId[]).map((id) => ({
    id,
    title: ROWS[id].title,
    category: ROWS[id].category,
    keywords: ROWS[id].keywords,
  })),
];

const categoryOf = (id: CategoryId): Category => CATEGORIES.find((entry) => entry.id === id) ?? CATEGORIES[0];

function matchesSearch(entry: SearchEntry, query: string): boolean {
  const needle = query.trim().toLowerCase();
  return [entry.title, ...entry.keywords].join(" ").toLowerCase().includes(needle);
}

// --- controls (real primitives, no bespoke form CSS) -------------------------------

function NumberStepper({
  value,
  onChange,
  min = 0,
  label,
}: {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  label: string;
}) {
  return (
    <InputGroup className="w-28">
      <InputGroupInput
        aria-label={label}
        inputMode="numeric"
        value={String(value)}
        onChange={(event) => onChange(Math.max(min, Number(event.target.value.replace(/\D/g, "")) || min))}
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

function BudgetInput({ model }: { model: SettingsModel }) {
  return (
    <InputGroup className="w-36">
      <InputGroupInput
        aria-label="Daily budget"
        inputMode="numeric"
        value={String(model.dailyBudget)}
        onChange={(event) => model.setDailyBudget(Number(event.target.value.replace(/\D/g, "")) || 0)}
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

function RowControl({ rowId, model }: { rowId: RowId; model: SettingsModel }) {
  switch (rowId) {
    case "close-to-hide":
      return (
        <Switch
          aria-label="Close to hide"
          checked={model.closeToHide}
          onCheckedChange={model.setCloseToHide}
        />
      );
    case "global-limit":
      return (
        <NumberStepper
          value={model.globalLimit}
          onChange={model.setGlobalLimit}
          min={1}
          label="Global concurrency"
        />
      );
    case "per-workspace-limit":
      return (
        <NumberStepper
          value={model.perWorkspaceLimit}
          onChange={model.setPerWorkspaceLimit}
          min={1}
          label="Per-workspace concurrency"
        />
      );
    case "daily-budget":
      return <BudgetInput model={model} />;
    default:
      return null;
  }
}

function SettingRow({ rowId, model, focused }: { rowId: RowId; model: SettingsModel; focused: boolean }) {
  const meta = ROWS[rowId];
  return (
    <Item id={`setting-${rowId}`} className={cn("scroll-mt-8 transition-colors", focused && "bg-primary/10")}>
      <ItemContent>
        <ItemTitle>{meta.title}</ItemTitle>
        <ItemDescription>{meta.description}</ItemDescription>
      </ItemContent>
      <ItemActions>
        <RowControl rowId={rowId} model={model} />
      </ItemActions>
    </Item>
  );
}

// Mock window preview, tinted per scheme (T3 Code's color-scheme picker).
function ThemePreview({ kind }: { kind: ThemeValue }) {
  const lightHalf = (
    <div className="flex-1 bg-white p-1.5">
      <div className="h-1.5 w-8 rounded-full bg-slate-200" />
      <div className="mt-1 h-1.5 w-10 rounded-full bg-slate-200" />
    </div>
  );
  const darkHalf = (
    <div className="flex-1 bg-slate-900 p-1.5">
      <div className="h-1.5 w-8 rounded-full bg-slate-600" />
      <div className="mt-1 h-1.5 w-10 rounded-full bg-slate-700" />
    </div>
  );
  return (
    <div className="flex h-20 overflow-hidden rounded-lg border">
      {kind === "dark" ? darkHalf : lightHalf}
      {kind === "system" && darkHalf}
    </div>
  );
}

function ThemePicker({ model }: { model: SettingsModel }) {
  return (
    <ToggleGroup
      className="grid w-full grid-cols-3 gap-3"
      value={[model.theme]}
      onValueChange={(values) => {
        const next = values[0] as ThemeValue | undefined;
        if (next) model.setTheme(next);
      }}
    >
      {THEME_TILES.map((tile) => {
        const Icon = tile.icon;
        return (
          <ToggleGroupItem
            key={tile.value}
            value={tile.value}
            aria-label={tile.label}
            className="h-auto w-full flex-col items-stretch gap-2 rounded-xl border border-input bg-transparent p-2 hover:bg-transparent aria-pressed:bg-transparent data-pressed:border-primary data-pressed:bg-transparent data-pressed:ring-2 data-pressed:ring-primary"
          >
            <ThemePreview kind={tile.value} />
            <span className="flex items-center gap-1.5 px-1 pb-1 text-sm font-medium">
              <Icon />
              {tile.label}
            </span>
          </ToggleGroupItem>
        );
      })}
    </ToggleGroup>
  );
}

// --- content ----------------------------------------------------------------------

function SubSectionBlock({
  sub,
  model,
  focus,
}: {
  sub: SubSection;
  model: SettingsModel;
  focus: SearchId | null;
}) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-medium text-muted-foreground">{sub.label}</h2>
      {sub.kind === "theme" ? (
        <div
          id="setting-theme"
          className={cn(
            "scroll-mt-8 rounded-xl transition-shadow",
            focus === "theme" && "ring-2 ring-primary ring-offset-4 ring-offset-background",
          )}
        >
          <ThemePicker model={model} />
        </div>
      ) : (
        <Card className="gap-0 py-0">
          {sub.rows.map((rowId, index) => (
            <Fragment key={rowId}>
              {index > 0 && <Separator />}
              <SettingRow rowId={rowId} model={model} focused={focus === rowId} />
            </Fragment>
          ))}
        </Card>
      )}
    </section>
  );
}

function CategoryPage({
  category,
  model,
  focus,
}: {
  category: Category;
  model: SettingsModel;
  focus: SearchId | null;
}) {
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-8 px-8 py-8">
      <h1 className="text-2xl font-semibold tracking-tight">{category.label}</h1>
      {SUBSECTIONS[category.id].map((sub) => (
        <SubSectionBlock key={sub.id} sub={sub} model={model} focus={focus} />
      ))}
    </div>
  );
}

// A search hit in the sidebar: category icon + setting name + category label (T3 Code style).
function SearchResultRow({ entry, onSelect }: { entry: SearchEntry; onSelect: () => void }) {
  const category = categoryOf(entry.category);
  const Icon = category.icon;
  return (
    <Item
      size="sm"
      render={<button type="button" onClick={onSelect} />}
      className="w-full cursor-pointer text-left hover:bg-sidebar-accent"
    >
      <ItemMedia variant="icon">
        <Icon />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>{entry.title}</ItemTitle>
        <ItemDescription>{category.label}</ItemDescription>
      </ItemContent>
    </Item>
  );
}

// --- shell (sidebar takeover) ------------------------------------------------------

function SettingsPrototype() {
  const navigate = useNavigate();
  const model = useSettingsModel();
  const [active, setActive] = useState<CategoryId>("general");
  const [query, setQuery] = useState("");
  // The setting a search hit jumped to; drives scroll-into-view + a transient highlight.
  const [focus, setFocus] = useState<SearchId | null>(null);
  const searching = query.trim() !== "";
  const category = categoryOf(active);
  const results = SEARCH_INDEX.filter((entry) => matchesSearch(entry, query));

  // Reveal a jumped-to setting: scroll it into view, then let the highlight fade.
  useEffect(() => {
    if (!focus) return;
    document.getElementById(`setting-${focus}`)?.scrollIntoView({ block: "center", behavior: "smooth" });
    const timer = window.setTimeout(() => setFocus(null), 1600);
    return () => window.clearTimeout(timer);
  }, [focus]);

  const openSetting = (entry: SearchEntry) => {
    setActive(entry.category);
    setQuery("");
    setFocus(entry.id);
  };

  return (
    <div className="fixed inset-0 z-[60] flex bg-background">
      <aside className="flex w-64 shrink-0 flex-col border-r bg-sidebar">
        <div className="h-11 shrink-0 [-webkit-app-region:drag]" />
        <div className="flex flex-col gap-3 px-3 pb-3">
          <Button
            size="sm"
            variant="ghost"
            className="w-fit justify-start px-2 [-webkit-app-region:no-drag]"
            onClick={() => navigate({ to: "/" })}
          >
            <RiArrowLeftLine data-icon="inline-start" />
            Back to app
          </Button>
          <InputGroup>
            <InputGroupInput
              placeholder="Search settings…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <InputGroupAddon>
              <RiSearchLine />
            </InputGroupAddon>
            {searching && (
              <InputGroupAddon align="inline-end">
                <InputGroupButton size="icon-xs" aria-label="Clear search" onClick={() => setQuery("")}>
                  <RiCloseLine />
                </InputGroupButton>
              </InputGroupAddon>
            )}
          </InputGroup>
        </div>
        <nav className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-auto px-2 pb-3">
          {searching ? (
            results.length > 0 ? (
              results.map((entry) => (
                <SearchResultRow key={entry.id} entry={entry} onSelect={() => openSetting(entry)} />
              ))
            ) : (
              <p className="px-2 py-3 text-sm text-muted-foreground">No settings match.</p>
            )
          ) : (
            CATEGORIES.map((entry) => {
              const Icon = entry.icon;
              return (
                <Button
                  key={entry.id}
                  size="sm"
                  variant={entry.id === active ? "secondary" : "ghost"}
                  className="w-full justify-start"
                  onClick={() => setActive(entry.id)}
                >
                  <Icon data-icon="inline-start" />
                  {entry.label}
                </Button>
              );
            })
          )}
        </nav>
      </aside>
      <main className="min-w-0 flex-1 overflow-auto">
        <CategoryPage category={category} model={model} focus={focus} />
      </main>
    </div>
  );
}

export const Route = createFileRoute("/settings-prototype")({
  component: SettingsPrototype,
});
