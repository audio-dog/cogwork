// Mirrors the engine's cogwork-fallback catalogs. Delete when #456 publishes the real one.
import type { LifecycleStage } from "@cogwork/contracts";

export interface CatalogChoice {
  readonly value: string;
  readonly label: string;
}

/** Which mark identifies a harness in the picker's rail. */
export type HarnessGlyph = "openai" | "cursor" | "sparkle";

export interface HarnessCatalog {
  readonly harness: string;
  readonly label: string;
  readonly glyph: HarnessGlyph;
  readonly models: readonly CatalogChoice[];
  /** Absent when the harness has no reasoning effort. The control disappears, never disables. */
  readonly efforts?: readonly CatalogChoice[];
}

const choices = (values: readonly string[]) => values.map((value) => ({ value, label: value }));

export const harnessCatalogs: readonly HarnessCatalog[] = [
  {
    harness: "codex",
    label: "Codex",
    glyph: "openai",
    models: choices(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]),
    efforts: choices(["minimal", "low", "medium", "high"]),
  },
  {
    harness: "cursor",
    label: "Cursor",
    glyph: "cursor",
    models: choices([
      "auto",
      "gpt-5.3-codex",
      "gpt-5.3-codex-high",
      "gpt-5.3-codex-xhigh",
      "claude-opus-5-thinking-high",
      "claude-fable-5-thinking-high",
      "composer-2.5",
    ]),
    efforts: choices(["none", "low", "medium", "high", "xhigh", "max"]),
  },
  {
    harness: "provider",
    label: "Provider",
    glyph: "sparkle",
    models: choices(["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"]),
  },
];

export const catalogFor = (harness: string | null) =>
  harnessCatalogs.find((candidate) => candidate.harness === harness) ?? null;

export const policyProfiles: readonly CatalogChoice[] = [
  { value: "read-only", label: "Read only" },
  { value: "full", label: "Full" },
];

/** The engine defaults a stage's policy profile, so an unset cell still inherits one. */
export const defaultProfile = (operation: LifecycleStage) =>
  operation === "implement" || operation === "follow-up" ? "full" : "read-only";
