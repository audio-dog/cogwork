import {
  RiBox3Line,
  RiCpuLine,
  RiEqualizerLine,
  RiGitRepositoryLine,
  RiNodeTree,
  RiPaletteLine,
  RiSettings3Line,
} from "@remixicon/react";
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
  // The configuration surfaces prototyped for #131. Which of these the sidebar shows depends on
  // the active variant, because "one surface or two" is part of what is being decided.
  { id: "plugins", label: "Plugins", icon: RiBox3Line },
  { id: "customize", label: "Customize", icon: RiEqualizerLine },
  { id: "workflows", label: "Workflows", icon: RiNodeTree },
  { id: "workspaces", label: "Workspaces", icon: RiGitRepositoryLine },
] as const satisfies readonly SettingsSection[];

/** The sections the #131 variants own. The rest are the app's existing settings. */
export const configurationSectionIds = ["plugins", "customize", "workflows", "workspaces"] as const;

export function isConfigurationSection(id: string): boolean {
  return (configurationSectionIds as readonly string[]).includes(id);
}

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
    description: "How many runs the scheduler starts per day before it pauses new work.",
    keywords: ["budget", "spend", "cost", "runs", "daily", "cap"],
  },
  {
    id: "installed-plugins",
    sectionId: "plugins",
    title: "Installed Plugins",
    description: "Install, update, and uninstall Plugins, and the setup that follows an install.",
    keywords: ["plugin", "install", "uninstall", "update", "catalog", "marketplace", "setup"],
  },
  {
    id: "contribution-enablement",
    sectionId: "customize",
    title: "Contribution on / off",
    description: "Turn a Skill, Rules, Command, Subagent, Hook, or MCP server on or off at a Scope.",
    keywords: ["skill", "rules", "command", "subagent", "hook", "mcp", "scope", "enable", "customize"],
  },
  {
    id: "operation-settings",
    sectionId: "workflows",
    title: "Operation settings",
    description: "Harness, model, effort, permission profile, and the contributions bound to a need.",
    keywords: ["operation", "workflow", "harness", "model", "effort", "binding", "run plan"],
  },
  {
    id: "registered-workspaces",
    sectionId: "workspaces",
    title: "Registered workspaces",
    description: "Register, deregister, and re-bind a workspace checkout path.",
    keywords: ["workspace", "register", "deregister", "re-bind", "checkout", "repository"],
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
