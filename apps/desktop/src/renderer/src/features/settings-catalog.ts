import { RiMoneyDollarCircleLine, RiPaletteLine, RiSpeedUpLine, RiWindow2Line } from "@remixicon/react";
import type { ComponentType } from "react";

export interface SettingsSection {
  readonly id: string;
  readonly label: string;
  readonly icon: ComponentType;
}

export const settingsSections = [
  { id: "appearance", label: "Appearance", icon: RiPaletteLine },
  { id: "window", label: "Window", icon: RiWindow2Line },
  { id: "scheduler", label: "Scheduler", icon: RiSpeedUpLine },
  { id: "budget", label: "Budget", icon: RiMoneyDollarCircleLine },
] as const satisfies readonly SettingsSection[];

export type SettingsSectionId = (typeof settingsSections)[number]["id"];

export interface SettingEntry {
  readonly id: string;
  readonly sectionId: SettingsSectionId;
  readonly title: string;
  readonly description: string;
  readonly keywords: readonly string[];
}

export const settingsIndex: readonly SettingEntry[] = [
  {
    id: "theme",
    sectionId: "appearance",
    title: "Theme",
    description: "System, light, or dark appearance for the app.",
    keywords: ["theme", "appearance", "dark", "light", "color", "mode"],
  },
  {
    id: "close-to-hide",
    sectionId: "window",
    title: "Close to hide",
    description: "Closing the window hides it and leaves the engine running.",
    keywords: ["close", "hide", "window", "tray", "dock", "quit"],
  },
  {
    id: "scheduler-limits",
    sectionId: "scheduler",
    title: "Concurrency limits",
    description: "How many runs the scheduler keeps in flight, globally and per workspace.",
    keywords: ["scheduler", "concurrency", "limit", "in flight", "runs", "parallel"],
  },
  {
    id: "daily-budget",
    sectionId: "budget",
    title: "Daily budget",
    description: "Spend ceiling per day before the engine pauses new work.",
    keywords: ["budget", "spend", "cost", "money", "daily", "cap"],
  },
];

export function isSettingsSectionId(value: string): value is SettingsSectionId {
  return settingsSections.some((section) => section.id === value);
}

export function findSection(id: string): SettingsSection | undefined {
  return settingsSections.find((section) => section.id === id);
}

export function searchSettings(query: string): readonly SettingEntry[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [];
  return settingsIndex.filter((entry) => {
    const haystack = [entry.title, entry.description, ...entry.keywords].join(" ").toLowerCase();
    return haystack.includes(needle);
  });
}
