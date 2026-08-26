import { describe, expect, it } from "vitest";
import { scopeKey } from "../features/configuration-model";
import {
  clankerWorkspaceId,
  cogworkWorkspaceId,
  contributionById,
  placeholderConfiguration,
} from "../features/configuration-placeholder";
import {
  allPlaceKeys,
  allPlaces,
  placeOf,
  summarize,
  toggle,
  visibleContributions,
} from "./customize-places";

const { workspaces } = placeholderConfiguration;

describe("the set of places", () => {
  it("is the machine plus two per workspace", () => {
    expect(allPlaces).toHaveLength(1 + workspaces.length * 2);
  });

  it("keeps two workspaces on one git remote distinct", () => {
    const sharing = workspaces.filter((workspace) => workspace.remote === "colonylabs/cogwork");
    expect(sharing.length).toBeGreaterThan(1);
    const keys = sharing.map((workspace) => scopeKey({ kind: "workspace-input", workspaceId: workspace.id }));
    expect(new Set(keys).size).toBe(sharing.length);
  });
});

describe("placeOf", () => {
  it("names the workspace for a repository-defined contribution", () => {
    const skill = contributionById("local/skill/release-notes");
    if (!skill) throw new Error("fixture is missing the skill");
    expect(placeOf(skill)).toBe(scopeKey({ kind: "workspace-input", workspaceId: cogworkWorkspaceId }));
  });

  it("leaves a machine-defined contribution unqualified", () => {
    const mcp = contributionById("plugin:linear/mcp/linear");
    if (!mcp) throw new Error("fixture is missing the MCP server");
    expect(placeOf(mcp)).toBe("runtime-host");
  });
});

describe("visibleContributions", () => {
  it("shows nothing when no place is checked", () => {
    expect(visibleContributions("skill", [], "")).toEqual([]);
  });

  it("separates two workspaces' repository contributions", () => {
    const cogworkRepo = scopeKey({ kind: "workspace-input", workspaceId: cogworkWorkspaceId });
    const clankerRepo = scopeKey({ kind: "workspace-input", workspaceId: clankerWorkspaceId });
    const fromCogwork = visibleContributions("skill", [cogworkRepo], "").map((entry) => entry.id);
    const fromClanker = visibleContributions("rules", [clankerRepo], "").map((entry) => entry.id);
    expect(fromCogwork).toContain("local/skill/release-notes");
    expect(fromClanker).toContain("local/rules/forge-style");
    expect(visibleContributions("rules", [cogworkRepo], "").map((e) => e.id)).not.toContain(
      "local/rules/forge-style",
    );
  });

  it("shows everything of a kind when every place is checked", () => {
    const all = visibleContributions("skill", allPlaceKeys, "");
    const skills = placeholderConfiguration.contributions.filter((entry) => entry.kind === "skill");
    expect(all).toHaveLength(skills.length);
  });
});

describe("summarize — what the trigger says", () => {
  it("names everything and nothing at the extremes", () => {
    expect(summarize(allPlaceKeys)).toBe("Everywhere");
    expect(summarize([])).toBe("Nothing selected");
  });

  it("names the one selected group on its own", () => {
    expect(summarize(["runtime-host"])).toBe("User");
    const cogworkRepo = scopeKey({ kind: "workspace-input", workspaceId: cogworkWorkspaceId });
    expect(summarize([cogworkRepo])).toBe("cogwork");
  });

  it("counts groups rather than places, because a person thinks in workspaces", () => {
    const cogworkRepo = scopeKey({ kind: "workspace-input", workspaceId: cogworkWorkspaceId });
    const cogworkPrivate = scopeKey({ kind: "private-overlay", workspaceId: cogworkWorkspaceId });
    // Both places, one workspace — so no "+1".
    expect(summarize([cogworkRepo, cogworkPrivate])).toBe("cogwork");
  });

  it("overflows to a +n once a second group is in play", () => {
    const cogworkRepo = scopeKey({ kind: "workspace-input", workspaceId: cogworkWorkspaceId });
    const clankerRepo = scopeKey({ kind: "workspace-input", workspaceId: clankerWorkspaceId });
    expect(summarize(["runtime-host", cogworkRepo])).toBe("User +1");
    expect(summarize([cogworkRepo, clankerRepo])).toBe("cogwork +1");
  });

  it("stays short enough for a fixed-width trigger", () => {
    // The trigger truncates at a fixed width so the popup's anchor never moves; a summary that
    // needed more than a workspace name plus an overflow count would defeat that.
    const longest = [...workspaces].sort((a, b) => b.name.length - a.name.length)[0];
    const key = scopeKey({ kind: "workspace-input", workspaceId: longest.id });
    expect(summarize([key, "runtime-host"]).length).toBeLessThanOrEqual(longest.name.length + 5);
  });
});

describe("toggle", () => {
  it("adds a place that is not selected and removes one that is", () => {
    expect(toggle([], "runtime-host")).toEqual(["runtime-host"]);
    expect(toggle(["runtime-host"], "runtime-host")).toEqual([]);
  });

  it("leaves the other places alone", () => {
    const repo = scopeKey({ kind: "workspace-input", workspaceId: cogworkWorkspaceId });
    expect(toggle(["runtime-host", repo], repo)).toEqual(["runtime-host"]);
  });
});
