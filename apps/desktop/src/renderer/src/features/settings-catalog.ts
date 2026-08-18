import { RiCpuLine, RiPaletteLine, RiSettings3Line } from "@remixicon/react";
import type { ComponentType } from "react";

export interface SettingsSection {
  readonly id: string;
  readonly label: string;
  readonly icon: ComponentType;
}

export const settingsSections = [
  { id: "general", label: "General", icon: RiSettings3Line },
  { id: "appearance", label: "Appearance", icon: RiPaletteLine },
  { id: "engine", label: "Engine", icon: RiCpuLine },
] as const satisfies readonly SettingsSection[];

export type SettingsSectionId = (typeof settingsSections)[number]["id"];

export interface SettingEntry {
  readonly id: string;
  readonly sectionId: SettingsSectionId;
  readonly title: string;
  readonly description: string;
  readonly keywords: readonly string[];
}

export const settingsIndex = [
  {
    id: "close-to-hide",
    sectionId: "general",
    title: "Close to hide",
    description: "Closing the window hides it and leaves the engine running.",
    keywords: ["close", "hide", "window", "tray", "menu bar", "quit"],
  },
  {
    id: "theme",
    sectionId: "appearance",
    title: "Theme",
    description: "System, light, or dark appearance for the app.",
    keywords: ["theme", "appearance", "dark", "light", "color", "scheme", "system"],
  },
  {
    id: "global-limit",
    sectionId: "engine",
    title: "Global concurrency",
    description: "How many runs the scheduler keeps in flight across all workspaces.",
    keywords: ["scheduler", "concurrency", "limit", "runs", "parallel", "global"],
  },
  {
    id: "per-workspace-limit",
    sectionId: "engine",
    title: "Per-workspace concurrency",
    description: "How many runs stay in flight inside a single workspace.",
    keywords: ["scheduler", "concurrency", "workspace", "limit", "runs"],
  },
  {
    id: "daily-budget",
    sectionId: "engine",
    title: "Daily budget",
    description: "Spend ceiling per day before the engine pauses new work.",
    keywords: ["budget", "spend", "cost", "money", "daily", "cap"],
  },
] as const satisfies readonly SettingEntry[];

export function isSettingsSectionId(value: string): value is SettingsSectionId {
  return settingsSections.some((section) => section.id === value);
}

export function findSection(id: string) {
  return settingsSections.find((section) => section.id === id);
}

export function settingsForSection(id: SettingsSectionId) {
  return settingsIndex.filter((entry) => entry.sectionId === id);
}

export function searchSettings(query: string) {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [] as SettingEntry[];
  return settingsIndex.filter((entry) =>
    [entry.title, ...entry.keywords].join(" ").toLowerCase().includes(needle),
  );
}
