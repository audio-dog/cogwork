import type { ConfigurationPicture, Contribution, InstalledPlugin } from "./configuration-model";

export type PluginAttention =
  | { readonly _tag: "settled" }
  | { readonly _tag: "load-failed"; readonly failed: readonly Contribution[] }
  | { readonly _tag: "setup-unfinished"; readonly remaining: number };

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

/** The Plugin axis, bound to one configuration. See {@link CustomizePlaces} for why it is bound. */
export interface PluginsView {
  readonly contributionsOf: (plugin: InstalledPlugin) => readonly Contribution[];
  readonly attentionOf: (plugin: InstalledPlugin) => PluginAttention;
  readonly needsAttention: (plugin: InstalledPlugin) => boolean;
}

export function pluginsView(picture: ConfigurationPicture): PluginsView {
  const { contributions } = picture;

  const contributionsOf = (plugin: InstalledPlugin) =>
    plugin.contributionIds
      .map((id) => contributions.find((contribution) => contribution.id === id))
      .filter((contribution) => contribution !== undefined);

  const attentionOf = (plugin: InstalledPlugin): PluginAttention => {
    const failed = contributionsOf(plugin).filter((contribution) => contribution.load._tag === "failed");
    if (failed.length > 0) return { _tag: "load-failed", failed };
    const remaining = plugin.setup.filter((step) => !step.done).length;
    if (remaining > 0) return { _tag: "setup-unfinished", remaining };
    return { _tag: "settled" };
  };

  return {
    contributionsOf,
    attentionOf,
    needsAttention: (plugin) => attentionOf(plugin)._tag !== "settled",
  };
}
