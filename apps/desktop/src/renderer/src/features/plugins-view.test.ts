import { describe, expect, it } from "vitest";
import { placeholderConfiguration } from "../testing/configuration";
import { attentionAction, attentionLine, PluginAttention, pluginsView } from "./plugins-view";

const { plugins } = placeholderConfiguration;
const { attentionOf, contributionsOf, needsAttention } = pluginsView(placeholderConfiguration);

function plugin(pluginId: string) {
  const found = plugins.find((entry) => entry.record.pluginId === pluginId);
  if (!found) throw new Error(`fixture is missing ${pluginId}`);
  return found;
}

describe("attentionOf", () => {
  it("settles a Plugin that loads and is set up", () => {
    // No update state: every Plugin ships with cogwork, so there is nothing to stage or offer.
    expect(attentionOf(plugin("gh-review"))).toEqual(PluginAttention.settled({}));
    expect(attentionOf(plugin("codex-extras"))).toEqual(PluginAttention.settled({}));
  });

  it("puts a file that will not load ahead of everything else", () => {
    // Granola has both a failed contribution and an unfinished setup step.
    const attention = attentionOf(plugin("granola"));
    expect(PluginAttention.$is("load-failed")(attention)).toBe(true);
  });

  it("puts an installed Plugin with a broken manifest in Needs Attention", () => {
    const attention = attentionOf({
      ...plugin("gh-review"),
      manifestFailure: "plugin.json is invalid",
    });
    expect(attention).toEqual(PluginAttention["manifest-failed"]({ reason: "plugin.json is invalid" }));
    expect(attentionLine(attention)).toBe("plugin.json is invalid");
  });

  it("reports an unfinished setup", () => {
    const attention = attentionOf(plugin("linear"));
    expect(attention).toEqual(PluginAttention["setup-unfinished"]({ remaining: 1 }));
  });
});

describe("needsAttention", () => {
  it("splits the list without dropping or duplicating a plugin", () => {
    const attention = plugins.filter(needsAttention);
    const settled = plugins.filter((entry) => !needsAttention(entry));
    expect(attention.length + settled.length).toBe(plugins.length);
    expect(settled.every((entry) => PluginAttention.$is("settled")(attentionOf(entry)))).toBe(true);
  });
});

describe("attentionLine and attentionAction", () => {
  it("names the act the state calls for", () => {
    expect(attentionAction(attentionOf(plugin("granola")))).toBe("Show the file");
    expect(attentionAction(attentionOf(plugin("linear")))).toBe("Finish setup");
    expect(attentionAction(attentionOf({ ...plugin("linear"), setup: [] }))).toBeUndefined();
  });

  it("names the one failed contribution rather than counting to one", () => {
    expect(attentionLine(attentionOf(plugin("granola")))).toBe("granola failed to load");
  });
});

describe("contributionsOf", () => {
  it("resolves every id a plugin claims", () => {
    for (const entry of plugins) {
      expect(contributionsOf(entry)).toHaveLength(entry.contributionIds.length);
    }
  });
});
