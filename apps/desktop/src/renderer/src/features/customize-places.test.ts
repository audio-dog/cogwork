import { describe, expect, it } from "vitest";
import {
  clankerWorkspaceId,
  cogworkWorkspaceId,
  contributionById,
  placeholderConfiguration,
} from "../testing/configuration";
import { Authority, scopeKey } from "./configuration-model";
import { customizePlaces, placeOf, profilePlace, toggle, workspaceScopeKinds } from "./customize-places";

const { workspaces } = placeholderConfiguration;

// The Place axis is bound to a configuration rather than importing one, so a test binds it too.
const {
  allPlaceKeys,
  allPlaces,
  countAt,
  countInWorkspace,
  groupContributions,
  kindCount,
  summarize,
  visibleContributions,
} = customizePlaces(placeholderConfiguration);

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
    const skill = contributionById("local:repo/skill/release-notes");
    if (!skill) throw new Error("fixture is missing the skill");
    expect(placeOf(skill)).toBe(scopeKey({ kind: "workspace-input", workspaceId: cogworkWorkspaceId }));
  });

  it("leaves a machine-defined contribution unqualified", () => {
    const mcp = contributionById("plugin:linear/mcp/linear");
    if (!mcp) throw new Error("fixture is missing the MCP server");
    expect(placeOf(mcp)).toBe("settings-profile");
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
    expect(fromCogwork).toContain("local:repo/skill/release-notes");
    expect(fromClanker).toContain("local:repo/rules/forge-style");
    expect(visibleContributions("rules", [cogworkRepo], "").map((e) => e.id)).not.toContain(
      "local:repo/rules/forge-style",
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
    expect(summarize(["settings-profile"])).toBe("User");
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
    expect(summarize(["settings-profile", cogworkRepo])).toBe("User +1");
    expect(summarize([cogworkRepo, clankerRepo])).toBe("cogwork +1");
  });

  it("stays short enough for a fixed-width trigger", () => {
    // The trigger truncates at a fixed width so the popup's anchor never moves; a summary that
    // needed more than a workspace name plus an overflow count would defeat that.
    const longest = [...workspaces].sort((a, b) => b.name.length - a.name.length)[0];
    const key = scopeKey({ kind: "workspace-input", workspaceId: longest.id });
    expect(summarize([key, "settings-profile"]).length).toBeLessThanOrEqual(longest.name.length + 5);
  });
});

describe("toggle", () => {
  it("adds a place that is not selected and removes one that is", () => {
    expect(toggle([], "settings-profile")).toEqual(["settings-profile"]);
    expect(toggle(["settings-profile"], "settings-profile")).toEqual([]);
  });

  it("leaves the other places alone", () => {
    const repo = scopeKey({ kind: "workspace-input", workspaceId: cogworkWorkspaceId });
    expect(toggle(["settings-profile", repo], repo)).toEqual(["settings-profile"]);
  });
});

describe("groupContributions", () => {
  it("drops empty groups — a checked place with nothing in it needs no heading", () => {
    const groups = groupContributions("rules", allPlaceKeys, "");
    for (const group of groups) expect(group.rows.length).toBeGreaterThan(0);
  });

  it("gives a Plugin its own section instead of lumping it in with your own files", () => {
    // Every Plugin contribution sits at the machine, because an install is machine-local — so
    // grouping by place alone could not tell a Plugin's Skill from one you wrote.
    const groups = groupContributions("skill", allPlaceKeys, "");
    const byPlugin = groups.find((group) => group.label === "GitHub review pack");
    expect(byPlugin?.rows.map((row) => row.id)).toEqual(["plugin:gh-review/skill/pr-summary"]);
    // And nothing a Plugin ships appears in any group that is not a Plugin's.
    const pluginNames = new Set(placeholderConfiguration.plugins.map((plugin) => plugin.name));
    const elsewhere = groups.filter((group) => !pluginNames.has(group.label)).flatMap((group) => group.rows);
    expect(elsewhere.every((row) => !Authority.$is("plugin")(row.authority))).toBe(true);
  });

  it("keeps your own machine-level files in the User group", () => {
    const groups = groupContributions("skill", allPlaceKeys, "");
    const mine = groups.find((group) => group.label === "User");
    expect(mine?.rows.map((row) => row.id)).toEqual([
      "local:user/skill/commit-style",
      "local:user/skill/scratch",
    ]);
  });

  it("lists a Command file under Skills with its source badge", () => {
    const groups = groupContributions("skill", allPlaceKeys, "");
    const linear = groups.find((group) => group.label === "Linear");
    const triage = linear?.rows.find((row) => row.file.endsWith("/commands/linear-triage.md"));
    expect(triage?.authority).toEqual(Authority.plugin({ pluginId: "linear" }));
  });

  it("names engine-authored contributions as built in", () => {
    const groups = groupContributions("rules", allPlaceKeys, "");
    const builtIn = groups.find((group) => group.label === "Built in");
    expect(builtIn?.rows.map((row) => row.id)).toEqual(["engine/rules/house-style"]);
  });

  it("orders groups from nearest to furthest — yours, ours, plugins', repos'", () => {
    const labels = groupContributions("rules", allPlaceKeys, "").map((group) => group.label);
    expect(labels.indexOf("Built in")).toBeLessThan(labels.indexOf("GitHub review pack"));
    expect(labels.indexOf("GitHub review pack")).toBeLessThan(labels.indexOf("clanker-forge · Everyone"));
  });

  it("names a repository group by its workspace and its place", () => {
    const labels = groupContributions("skill", allPlaceKeys, "").map((group) => group.label);
    expect(labels).toContain("cogwork · Everyone");
    expect(labels).toContain("cogwork · Just me");
  });

  it("puts every visible contribution in exactly one group", () => {
    const visible = visibleContributions("skill", allPlaceKeys, "");
    const grouped = groupContributions("skill", allPlaceKeys, "").flatMap((group) => group.rows);
    expect(grouped).toHaveLength(visible.length);
    expect(new Set(grouped.map((row) => row.id)).size).toBe(visible.length);
  });

  it("honours the place filter", () => {
    const repo = scopeKey({ kind: "workspace-input", workspaceId: cogworkWorkspaceId });
    const groups = groupContributions("skill", [repo], "");
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe("cogwork · Everyone");
  });
});

describe("search", () => {
  it("matches on the local name", () => {
    const found = visibleContributions("skill", allPlaceKeys, "commit").map((row) => row.id);
    expect(found).toEqual(["local:user/skill/commit-style"]);
  });

  it("matches on the summary", () => {
    const found = visibleContributions("skill", allPlaceKeys, "release notes").map((row) => row.id);
    expect(found).toEqual(["local:repo/skill/release-notes"]);
  });

  it("ignores case and surrounding whitespace", () => {
    const loose = visibleContributions("skill", allPlaceKeys, "  COMMIT  ").map((row) => row.id);
    expect(loose).toEqual(["local:user/skill/commit-style"]);
  });

  it("returns everything for an empty query", () => {
    const all = visibleContributions("skill", allPlaceKeys, "");
    expect(visibleContributions("skill", allPlaceKeys, "   ")).toEqual(all);
  });

  it("narrows the groups it feeds", () => {
    const groups = groupContributions("skill", allPlaceKeys, "commit");
    expect(groups.map((group) => group.label)).toEqual(["User"]);
  });
});

describe("countAt and kindCount", () => {
  it("counts only the given kind at the given place", () => {
    expect(countAt(profilePlace, "skill")).toBe(5);
    expect(countAt({ kind: "workspace-input", workspaceId: cogworkWorkspaceId }, "skill")).toBe(1);
    expect(countAt({ kind: "workspace-input", workspaceId: clankerWorkspaceId }, "skill")).toBe(1);
    expect(countAt(profilePlace, "rules")).toBe(2);
  });

  it("counts what lives in a workspace across both of its places", () => {
    // The nav row badges contributions, not how many of its two checkboxes are ticked.
    const repo = countAt({ kind: "workspace-input", workspaceId: cogworkWorkspaceId }, "skill");
    const overlay = countAt({ kind: "private-overlay", workspaceId: cogworkWorkspaceId }, "skill");
    expect(countInWorkspace(cogworkWorkspaceId, "skill")).toBe(repo + overlay);
    expect(countInWorkspace(cogworkWorkspaceId, "skill")).toBeGreaterThan(workspaceScopeKinds.length - 1);
  });

  it("counts a kind across the selected places only", () => {
    const everywhere = kindCount("rules", allPlaceKeys);
    const machineOnly = kindCount("rules", ["settings-profile"]);
    expect(machineOnly).toBeLessThan(everywhere);
    expect(kindCount("rules", [])).toBe(0);
  });
});
