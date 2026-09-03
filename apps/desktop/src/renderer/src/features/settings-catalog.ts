import { RiPaletteLine, RiRobot2Line, RiSettings3Line, RiSpeedUpLine } from "@remixicon/react";
import { linkOptions } from "@tanstack/react-router";

/**
 * Every section is its own route, so `linkOptions` checks each target where it is written rather
 * than at each spread site. A typo here fails the build instead of redirecting at runtime.
 */
const sectionLinks = linkOptions([
  { to: "/settings/general" },
  { to: "/settings/scheduling" },
  { to: "/settings/appearance" },
  { to: "/settings/harnesses" },
]);

export const settingsSections = [
  { id: "general", label: "General", icon: RiSettings3Line, link: sectionLinks[0] },
  { id: "scheduling", label: "Scheduling", icon: RiSpeedUpLine, link: sectionLinks[1] },
  { id: "appearance", label: "Appearance", icon: RiPaletteLine, link: sectionLinks[2] },
  { id: "harnesses", label: "Providers", icon: RiRobot2Line, link: sectionLinks[3] },
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
    id: "profiling",
    sectionId: "general",
    title: "Profiling",
    description: "Record CPU and heap allocation profiles for the engine daemon.",
    keywords: ["profiling", "cpu profile", "heap profile", "diagnostics", "performance"],
  },
  {
    id: "process-captures",
    sectionId: "general",
    title: "Process captures",
    description: "Capture a heap snapshot or CPU profile from a live Cogwork process.",
    keywords: ["capture", "heap snapshot", "cpu profile", "daemon", "main process"],
  },
  {
    id: "global-concurrency",
    sectionId: "scheduling",
    title: "Runs at once",
    description: "How many Runs the daemon keeps in flight across every workspace.",
    keywords: ["concurrency", "parallel", "limit", "runs", "scheduler", "global"],
  },
  {
    id: "per-workspace-concurrency",
    sectionId: "scheduling",
    title: "Runs at once per workspace",
    description: "The default a workspace inherits when it sets no concurrency of its own.",
    keywords: ["concurrency", "workspace", "limit", "runs", "scheduler", "default"],
  },
  {
    id: "daily-budget",
    sectionId: "scheduling",
    title: "Runs per day",
    description: "How many Runs may start each day before the scheduler pauses new work.",
    keywords: ["budget", "daily", "spend", "cap", "limit", "runs", "pause"],
  },
  {
    id: "provider-readiness",
    sectionId: "harnesses",
    title: "Provider readiness",
    description: "Whether each coding agent on this machine is installed, supported and signed in.",
    keywords: [
      "provider",
      "providers",
      "harness",
      "harnesses",
      "coding agent",
      "readiness",
      "installed",
      "version",
      "codex",
      "claude",
      "cursor",
      "anthropic",
    ],
  },
  {
    id: "provider-sign-in",
    sectionId: "harnesses",
    title: "Provider sign-in",
    description: "The command that signs you in to a coding agent that owns its own login.",
    keywords: ["sign in", "signin", "login", "authenticate", "credential", "account", "provider", "harness"],
  },
  {
    id: "provider-models",
    sectionId: "harnesses",
    title: "Provider models",
    description: "The models each coding agent offers on this machine.",
    keywords: ["models", "model list", "catalog", "provider", "harness", "gpt", "claude", "opus", "sonnet"],
  },
  {
    id: "theme",
    sectionId: "appearance",
    title: "Theme",
    description: "System, light, or dark appearance for the app.",
    keywords: ["theme", "appearance", "dark", "light", "color", "scheme", "system"],
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

export function settingEntry(id: string) {
  const found = settingsIndex.find((entry) => entry.id === id);
  if (!found) throw new Error(`Unknown setting: ${id}`);
  return found;
}

/** Kept so a section's icon can be looked up by id without narrowing on the literal union. */
export const sectionIcon = (id: SettingsSectionId) => findSection(id)?.icon;
