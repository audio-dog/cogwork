import { RiCpuLine, RiPaletteLine, RiSettings3Line } from "@remixicon/react";
import { linkOptions } from "@tanstack/react-router";
import type { ComponentType } from "react";

/**
 * Every section is its own route, so `linkOptions` checks each target where it is written rather
 * than at each spread site. A typo here fails the build instead of redirecting at runtime.
 */
const sectionLinks = linkOptions([
  { to: "/settings/general" },
  { to: "/settings/appearance" },
  { to: "/settings/engine" },
]);

export const settingsSections = [
  { id: "general", label: "General", icon: RiSettings3Line, link: sectionLinks[0] },
  { id: "appearance", label: "Appearance", icon: RiPaletteLine, link: sectionLinks[1] },
  { id: "engine", label: "Engine", icon: RiCpuLine, link: sectionLinks[2] },
] as const;

export type SettingsSection = (typeof settingsSections)[number];

export type SettingsSectionId = SettingsSection["id"];

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
    description: "How many runs the scheduler starts per day before it pauses new work.",
    keywords: ["budget", "spend", "cost", "runs", "daily", "cap"],
  },
] as const satisfies readonly SettingEntry[];

export function findSection(id: SettingsSectionId) {
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

export function settingEntry(id: string): SettingEntry {
  const found = settingsIndex.find((entry) => entry.id === id);
  if (!found) throw new Error(`Unknown setting: ${id}`);
  return found;
}

/** Kept so a section's icon can be looked up by id without narrowing on the literal union. */
export const sectionIcon = (id: SettingsSectionId): ComponentType | undefined => findSection(id)?.icon;
