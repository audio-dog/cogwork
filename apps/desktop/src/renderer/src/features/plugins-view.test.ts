import { describe, expect, it } from "vitest";
import { placeholderConfiguration } from "./configuration-placeholder";
import { attentionAction, attentionLine, pluginsView } from "./plugins-view";

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
    expect(attentionOf(plugin("gh-review"))).toEqual({ _tag: "settled" });
    expect(attentionOf(plugin("codex-extras"))).toEqual({ _tag: "settled" });
  });

  it("puts a file that will not load ahead of everything else", () => {
    // Granola has both a failed contribution and an unfinished setup step.
    const attention = attentionOf(plugin("granola"));
    expect(attention._tag).toBe("load-failed");
  });

  it("puts an installed Plugin with a broken manifest in Needs Attention", () => {
    const attention = attentionOf({
      ...plugin("gh-review"),
      manifestFailure: "plugin.json is invalid",
    });
    expect(attention).toEqual({
      _tag: "manifest-failed",
      reason: "plugin.json is invalid",
    });
    expect(attentionLine(attention)).toBe("plugin.json is invalid");
  });

  it("reports an unfinished setup", () => {
    const attention = attentionOf(plugin("linear"));
    expect(attention).toEqual({ _tag: "setup-unfinished", remaining: 1 });
  });
});

describe("needsAttention", () => {
  it("splits the list without dropping or duplicating a plugin", () => {
    const attention = plugins.filter(needsAttention);
    const settled = plugins.filter((entry) => !needsAttention(entry));
    expect(attention.length + settled.length).toBe(plugins.length);
    expect(settled.every((entry) => attentionOf(entry)._tag === "settled")).toBe(true);
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
