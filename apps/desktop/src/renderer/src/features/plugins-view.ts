import * as Data from "effect/Data";

import type { ConfigurationPicture, Contribution, InstalledPlugin } from "./configuration-model";
import { LoadState } from "./configuration-model";

declare const emptyVariant: unique symbol;
type EmptyVariant = { readonly [emptyVariant]?: never };

export type PluginAttention = Data.TaggedEnum<{
  settled: EmptyVariant;
  "manifest-failed": { readonly reason: string };
  "load-failed": { readonly failed: readonly Contribution[] };
  "setup-unfinished": { readonly remaining: number };
}>;

export const PluginAttention = Data.taggedEnum<PluginAttention>();

export const attentionLine = PluginAttention.$match({
  settled: () => "",
  "manifest-failed": ({ reason }) => reason,
  "load-failed": ({ failed }) =>
    failed.length === 1 ? `${failed[0].localName} failed to load` : `${failed.length} files failed to load`,
  "setup-unfinished": ({ remaining }) => `${remaining} setup ${remaining === 1 ? "step" : "steps"} left`,
});

export const attentionAction = PluginAttention.$match({
  settled: () => undefined,
  "manifest-failed": () => undefined,
  "load-failed": () => "Show the file",
  "setup-unfinished": () => "Finish setup",
});

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
    if (plugin.manifestFailure) return PluginAttention["manifest-failed"]({ reason: plugin.manifestFailure });
    const failed = contributionsOf(plugin).filter((contribution) =>
      LoadState.$is("failed")(contribution.load),
    );
    if (failed.length > 0) return PluginAttention["load-failed"]({ failed });
    const remaining = plugin.setup.filter((step) => !step.done).length;
    if (remaining > 0) return PluginAttention["setup-unfinished"]({ remaining });
    return PluginAttention.settled({});
  };

  return {
    contributionsOf,
    attentionOf,
    needsAttention: (plugin) => !PluginAttention.$is("settled")(attentionOf(plugin)),
  };
}
