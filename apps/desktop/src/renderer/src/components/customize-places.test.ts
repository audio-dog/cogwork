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
  toggle,
  toggleColumn,
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

describe("toggleColumn", () => {
  it("checks every workspace's repository at once", () => {
    const next = toggleColumn([], "workspace-input");
    expect(next).toHaveLength(workspaces.length);
    expect(next).toContain(scopeKey({ kind: "workspace-input", workspaceId: clankerWorkspaceId }));
    expect(next).not.toContain("runtime-host");
  });

  it("clears the column when it is already whole", () => {
    const full = toggleColumn([], "workspace-input");
    expect(toggleColumn(full, "workspace-input")).toEqual([]);
  });

  it("completes a partly-checked column rather than clearing it", () => {
    const partial = [scopeKey({ kind: "workspace-input", workspaceId: cogworkWorkspaceId })];
    expect(toggleColumn(partial, "workspace-input")).toHaveLength(workspaces.length);
  });

  it("leaves the other column and the machine alone", () => {
    const start = toggle(
      ["runtime-host"],
      scopeKey({ kind: "private-overlay", workspaceId: cogworkWorkspaceId }),
    );
    const next = toggleColumn(start, "workspace-input");
    expect(next).toContain("runtime-host");
    expect(next).toContain(scopeKey({ kind: "private-overlay", workspaceId: cogworkWorkspaceId }));
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
