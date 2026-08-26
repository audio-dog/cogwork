import type { Contribution, InstalledPlugin } from "./configuration-model";
import { placeholderConfiguration } from "./configuration-placeholder";

const { contributions } = placeholderConfiguration;

export type PluginAttention =
  | { readonly _tag: "settled" }
  | { readonly _tag: "load-failed"; readonly failed: readonly Contribution[] }
  | { readonly _tag: "setup-unfinished"; readonly remaining: number };

export function contributionsOf(plugin: InstalledPlugin): readonly Contribution[] {
  return plugin.contributionIds
    .map((id) => contributions.find((contribution) => contribution.id === id))
    .filter((contribution) => contribution !== undefined);
}

export function attentionOf(plugin: InstalledPlugin): PluginAttention {
  const failed = contributionsOf(plugin).filter((contribution) => contribution.load._tag === "failed");
  if (failed.length > 0) return { _tag: "load-failed", failed };
  const remaining = plugin.setup.filter((step) => !step.done).length;
  if (remaining > 0) return { _tag: "setup-unfinished", remaining };
  return { _tag: "settled" };
}

export function needsAttention(plugin: InstalledPlugin): boolean {
  return attentionOf(plugin)._tag !== "settled";
}

export function attentionLine(attention: PluginAttention): string {
  if (attention._tag === "load-failed") {
    return attention.failed.length === 1
      ? `${attention.failed[0].localName} failed to load`
      : `${attention.failed.length} files failed to load`;
  }
  if (attention._tag === "setup-unfinished") {
    return `${attention.remaining} setup ${attention.remaining === 1 ? "step" : "steps"} left`;
  }
  return "";
}

export function attentionAction(attention: PluginAttention): string | undefined {
  if (attention._tag === "load-failed") return "Show the file";
  if (attention._tag === "setup-unfinished") return "Finish setup";
  return undefined;
}

export function sourceLine(plugin: InstalledPlugin): string {
  const { source } = plugin.record;
  return source._tag === "catalog" ? "Ships with cogwork" : `Local path · ${source.path}`;
}

export function addedEntryIds(): readonly string[] {
  return placeholderConfiguration.plugins.map((plugin) => plugin.record.pluginId);
}
