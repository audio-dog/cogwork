import { describe, expect, it } from "vitest";
import { placeholderConfiguration } from "./configuration-placeholder";
import { attentionAction, attentionLine, attentionOf, contributionsOf, needsAttention } from "./plugins-view";

const { plugins } = placeholderConfiguration;

function plugin(pluginId: string) {
  const found = plugins.find((entry) => entry.record.pluginId === pluginId);
  if (!found) throw new Error(`fixture is missing ${pluginId}`);
  return found;
}

describe("attentionOf", () => {
  it("puts a file that will not load ahead of everything else", () => {
    // Granola has both a failed contribution and an unfinished setup step.
    const attention = attentionOf(plugin("granola"));
    expect(attention._tag).toBe("load-failed");
  });

  it("reports staged bytes, which are waiting on a person", () => {
    const attention = attentionOf(plugin("gh-review"));
    expect(attention).toEqual({ _tag: "update-staged", identity: "gh-review@2.2.0" });
  });

  it("reports an unfinished setup", () => {
    const attention = attentionOf(plugin("linear"));
    expect(attention).toEqual({ _tag: "setup-unfinished", remaining: 1 });
  });

  it("ranks an update merely on offer below everything else", () => {
    const attention = attentionOf(plugin("codex-extras"));
    expect(attention).toEqual({ _tag: "update-available", identity: "codex-extras@0.9.4" });
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
    expect(attentionAction(attentionOf(plugin("gh-review")))).toBe("Review");
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
