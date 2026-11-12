import { describe, expect, it } from "vitest";
import { cogworkWorkspaceId, contributionById, placeholderConfiguration } from "../testing/configuration";
import {
  Authority,
  type Contribution,
  Diagnostic,
  enablementScopes,
  LoadState,
  type ScopeRef,
  scopeOrder,
  type WorkspaceId,
} from "./configuration-model";
import {
  definedScope,
  diagnosticsOf,
  displayedEnablement,
  enableScopeFor,
  offeredElsewhere,
  resolveEnablement,
  settingsSpreadAcross,
  viewOf,
} from "./configuration-resolve";

const view = { workspaceId: cogworkWorkspaceId };

function required(id: string): Contribution {
  const contribution = contributionById(id);
  if (!contribution) throw new Error(`fixture is missing ${id}`);
  return contribution;
}

describe("resolveEnablement", () => {
  it("lets the highest Scope win whole", () => {
    // On at the Runtime host, off at the Private workspace overlay.
    const resolved = resolveEnablement(required("plugin:linear/mcp/linear"), view);
    expect(resolved.effective).toBe(false);
    expect(resolved.winner?.scope.kind).toBe("private-overlay");
    expect(resolved.shadowed.map((row) => row.scope.kind)).toEqual(["settings-profile"]);
  });

  it("has nothing to resolve for a kind that has no on / off", () => {
    // A Skill, Rules and a Subagent are files: on the disk or not. There is no setting.
    for (const id of [
      "plugin:gh-review/subagent/reviewer",
      "local:user/skill/commit-style",
      "engine/rules/house-style",
    ]) {
      const resolved = resolveEnablement(required(id), view);
      expect(enablementScopes[required(id).kind]).toEqual([]);
      expect(resolved.effective).toBeUndefined();
      expect(resolved.winner).toBeUndefined();
    }
  });

  it("drops an MCP server enablement written at the repository", () => {
    // A cloned repository may ship the file but may never start a process on your machine.
    const resolved = resolveEnablement(required("local:repo/mcp/repo-tools"), view);
    expect(resolved.dropped.map((entry) => Diagnostic.$is("inadmissible")(entry.diagnostic))).toEqual([true]);
    expect(resolved.dropped[0]?.row.scope.kind).toBe("workspace-input");
    // Dropped, so nothing resolves — and that is not the same as off.
    expect(resolved.effective).toBeUndefined();
  });

  it("drops a setting that references a contribution which no longer exists", () => {
    const resolved = resolveEnablement(required("plugin:granola/mcp/granola"), view);
    expect(resolved.dropped.map((entry) => Diagnostic.$is("dangling")(entry.diagnostic))).toEqual([true]);
    expect(resolved.effective).toBeUndefined();
  });

  it("ignores rows belonging to a workspace that is not in view", () => {
    const other = { workspaceId: "ws_nothing" as WorkspaceId };
    const resolved = resolveEnablement(required("plugin:linear/mcp/linear"), other);
    // The overlay row belongs to another workspace, so the profile row wins here.
    expect(resolved.effective).toBe(true);
    expect(resolved.winner?.scope.kind).toBe("settings-profile");
  });

  it("shows and edits a dangling overlay at its stored scope", () => {
    const contribution = {
      id: "plugin:linear/mcp/linear",
      authority: Authority.plugin({ pluginId: "linear" }),
      kind: "mcp-server",
      localName: "linear",
      summary: "Linear MCP",
      file: "/plugins/linear/mcp/linear.json",
      definedAt: "settings-profile",
      definedIn: cogworkWorkspaceId,
      load: LoadState.loaded({}),
      rows: [
        { scope: { kind: "settings-profile" }, value: true, source: "Control store" },
        {
          scope: { kind: "private-overlay", workspaceId: cogworkWorkspaceId },
          value: false,
          source: "Control store",
          diagnostic: Diagnostic.dangling({
            source: "Control store",
            detail: "The workspace was removed.",
          }),
        },
      ],
    } satisfies Contribution;

    const resolved = resolveEnablement(contribution, viewOf(contribution));

    expect(resolved.effective).toBe(true);
    expect(displayedEnablement(resolved)).toBe(false);
    expect(enableScopeFor(contribution)).toEqual({
      kind: "private-overlay",
      workspaceId: cogworkWorkspaceId,
    });
  });

  it("never reconciles two contributions that share a local name", () => {
    const fromPlugin = required("plugin:linear/mcp/linear");
    const fromLocal = required("local:private/mcp/linear");
    expect(fromPlugin.localName).toBe(fromLocal.localName);
    expect(fromPlugin.id).not.toBe(fromLocal.id);
    // Same name, opposite answers, and cogwork keeps them apart rather than merging them.
    expect(resolveEnablement(fromPlugin, view).effective).toBe(false);
    expect(resolveEnablement(fromLocal, view).effective).toBe(true);
  });
});

describe("which kinds have an on / off", () => {
  it("gives an on / off only to the MCP server", () => {
    expect(enablementScopes["mcp-server"]).toEqual(["settings-profile", "private-overlay"]);
    for (const kind of ["skill", "rules", "subagent", "hook"] as const) {
      expect(enablementScopes[kind]).toEqual([]);
    }
  });

  it("keeps the repository out of the one that does", () => {
    expect(enablementScopes["mcp-server"]).not.toContain("workspace-input");
    expect(enablementScopes["mcp-server"]).not.toContain("runtime-host");
  });
});

describe("the fixture itself", () => {
  it("covers every contribution kind cogwork can run today", () => {
    // Four of the five. Hooks are out of scope for this map, so the fixture holds none and the
    // facet says so rather than showing an empty list.
    const kinds = new Set(placeholderConfiguration.contributions.map((entry) => entry.kind));
    expect(kinds.has("hook")).toBe(false);
    expect(kinds.size).toBe(4);
  });

  it("keeps two workspaces that share one git remote", () => {
    const remotes = placeholderConfiguration.workspaces.map((workspace) => workspace.remote);
    const shared = remotes.filter((remote) => remotes.filter((other) => other === remote).length > 1);
    expect(shared.length).toBeGreaterThan(1);
  });

  it("names a Scope instance without deriving it from the environment", () => {
    const scope: ScopeRef = { kind: "private-overlay", workspaceId: cogworkWorkspaceId };
    expect(scope.workspaceId).toBe(cogworkWorkspaceId);
    expect(String(cogworkWorkspaceId).startsWith("ws_")).toBe(true);
  });
});

describe("where a contribution lives, and where it is turned on", () => {
  it("has nowhere to write for a kind with no on / off", () => {
    const skill = required("local:repo/skill/release-notes");
    expect(skill.definedAt).toBe("workspace-input");
    expect(enableScopeFor(skill)).toBeUndefined();
  });

  it("redirects a repo-shipped MCP server to a Scope that may enable it", () => {
    const server = required("local:repo/mcp/repo-tools");
    expect(server.definedAt).toBe("workspace-input");
    // A repository may ship the file and may never start a process on your machine.
    expect(offeredElsewhere(server)).toBe(true);
    const target = enableScopeFor(server);
    expect(target?.kind).toBe("private-overlay");
    // The overlay of the workspace it lives in — not of whichever workspace a picker had selected.
    expect(target?.workspaceId).toBe(server.definedIn);
  });

  it("keeps a machine-defined contribution on the machine", () => {
    const mcp = required("plugin:linear/mcp/linear");
    expect(mcp.definedAt).toBe("settings-profile");
    expect(enableScopeFor(mcp)?.kind).toBe("settings-profile");
  });

  it("edits a user MCP server at its effective workspace overlay", () => {
    const mcp = {
      id: "local:user/mcp/review",
      authority: Authority.local({ tree: "user" }),
      kind: "mcp-server",
      localName: "review",
      summary: "/home/.agents/mcp/review.json",
      file: "/home/.agents/mcp/review.json",
      definedAt: "settings-profile",
      definedIn: cogworkWorkspaceId,
      load: LoadState.loaded({}),
      rows: [
        { scope: { kind: "settings-profile" }, value: true, source: "Control store" },
        {
          scope: { kind: "private-overlay", workspaceId: cogworkWorkspaceId },
          value: false,
          source: "Control store",
        },
      ],
    } satisfies Contribution;

    expect(resolveEnablement(mcp, viewOf(mcp)).effective).toBe(false);
    expect(enableScopeFor(mcp)).toEqual({
      kind: "private-overlay",
      workspaceId: cogworkWorkspaceId,
    });
    expect(definedScope(mcp)).toEqual({ kind: "settings-profile" });
  });

  it("puts every contribution in exactly one place", () => {
    for (const contribution of placeholderConfiguration.contributions) {
      expect(scopeOrder).toContain(contribution.definedAt);
    }
  });

  it("represents all three places in the fixture", () => {
    const places = new Set(placeholderConfiguration.contributions.map((entry) => entry.definedAt));
    expect(places.size).toBe(scopeOrder.length);
  });
});

describe("settingsSpreadAcross", () => {
  it("stays empty for the ordinary case of one value in one place", () => {
    expect(settingsSpreadAcross(required("local:private/mcp/linear"))).toEqual([]);
  });

  it("stays empty for a kind that has no on / off to spread", () => {
    expect(settingsSpreadAcross(required("local:user/skill/commit-style"))).toEqual([]);
  });

  it("names every Scope when one identity carries a value in more than one", () => {
    // The exception ADR 0013's direction exists for. It is a badge, not the shape of the page.
    const spread = settingsSpreadAcross(required("plugin:linear/mcp/linear"));
    expect(spread).toEqual(["private-overlay", "settings-profile"]);
  });
});

describe("diagnosticsOf", () => {
  it("reports a machine-level contribution's overlay diagnostic, which its own view hides", () => {
    // Granola sits at the Settings profile, so it has no `definedIn` and every workspace-scoped row
    // falls outside its own view. Resolving still drops the row — but the reason must still show.
    const granola = required("plugin:granola/mcp/granola");
    expect(granola.definedIn).toBeUndefined();

    const inItsOwnView = resolveEnablement(granola, viewOf(granola)).dropped;
    expect(inItsOwnView).toHaveLength(0);

    const reported = diagnosticsOf(granola);
    expect(reported.map((entry) => Diagnostic.$is("dangling")(entry.diagnostic))).toEqual([true]);
    expect(reported[0].row.scope.workspaceId).toBe(cogworkWorkspaceId);
  });

  it("still reports a row the view does include", () => {
    const repoTools = required("local:repo/mcp/repo-tools");
    expect(diagnosticsOf(repoTools).length).toBeGreaterThan(0);
  });

  it("says nothing about a contribution whose settings are all admissible", () => {
    expect(diagnosticsOf(required("plugin:linear/mcp/linear"))).toEqual([]);
  });
});
