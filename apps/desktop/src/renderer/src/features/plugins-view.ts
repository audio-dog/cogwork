// What a Plugin needs from you, if anything.
//
// Cursor groups its MCPs by status and its Subagents by place, picking whichever axis carries the
// information on that facet. For an install the answer is status: a Plugin you installed and set up
// needs nothing said about it, and one with staged bytes, a malformed file or an unfinished setup
// needs saying now.

import type { Contribution, InstalledPlugin } from "./configuration-model";
import { placeholderConfiguration } from "./configuration-placeholder";

const { contributions } = placeholderConfiguration;

export type PluginAttention =
  | { readonly _tag: "settled" }
  | { readonly _tag: "update-staged"; readonly identity: string }
  | { readonly _tag: "update-available"; readonly identity: string }
  | { readonly _tag: "load-failed"; readonly failed: readonly Contribution[] }
  | { readonly _tag: "setup-unfinished"; readonly remaining: number };

export function contributionsOf(plugin: InstalledPlugin): readonly Contribution[] {
  return plugin.contributionIds
    .map((id) => contributions.find((contribution) => contribution.id === id))
    .filter((contribution) => contribution !== undefined);
}

/**
 * Ordered by how much it matters: a file that will not load beats bytes waiting for consent, which
 * beats an install that never finished, which beats an update merely on offer.
 */
export function attentionOf(plugin: InstalledPlugin): PluginAttention {
  const failed = contributionsOf(plugin).filter((contribution) => contribution.load._tag === "failed");
  if (failed.length > 0) return { _tag: "load-failed", failed };
  if (plugin.update._tag === "staged") {
    return { _tag: "update-staged", identity: plugin.update.resolvedIdentity };
  }
  const remaining = plugin.setup.filter((step) => !step.done).length;
  if (remaining > 0) return { _tag: "setup-unfinished", remaining };
  if (plugin.update._tag === "available") {
    return { _tag: "update-available", identity: plugin.update.resolvedIdentity };
  }
  return { _tag: "settled" };
}

export function needsAttention(plugin: InstalledPlugin): boolean {
  return attentionOf(plugin)._tag !== "settled";
}

/** One line for the row, so a person can triage the list without opening anything. */
export function attentionLine(attention: PluginAttention): string {
  if (attention._tag === "load-failed") {
    const one = attention.failed.length === 1;
    return one
      ? `${attention.failed[0].localName} failed to load`
      : `${attention.failed.length} contributions failed to load`;
  }
  if (attention._tag === "update-staged") return `${attention.identity} is staged, waiting on you`;
  if (attention._tag === "setup-unfinished") {
    return `Setup unfinished — ${attention.remaining} ${attention.remaining === 1 ? "step" : "steps"} left`;
  }
  if (attention._tag === "update-available") return `${attention.identity} is available`;
  return "";
}

/** The label on the row's action, which is the act the attention state calls for. */
export function attentionAction(attention: PluginAttention): string | undefined {
  if (attention._tag === "load-failed") return "Show the file";
  if (attention._tag === "update-staged") return "Review";
  if (attention._tag === "setup-unfinished") return "Finish setup";
  if (attention._tag === "update-available") return "Stage update";
  return undefined;
}

export function sourceLine(plugin: InstalledPlugin): string {
  const { source } = plugin.record;
  return source._tag === "catalog" ? `Catalog · ${source.entryId}` : `Local path · ${source.path}`;
}
