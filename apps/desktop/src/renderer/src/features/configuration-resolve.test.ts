import { describe, expect, it } from "vitest";
import {
  type Contribution,
  hasToggle,
  type ScopeRef,
  scopeOrder,
  type WorkspaceId,
} from "./configuration-model";
import { cogworkWorkspaceId, contributionById, placeholderConfiguration } from "./configuration-placeholder";
import {
  cellPermitted,
  enableScopeFor,
  offeredElsewhere,
  resolveEnablement,
  settingsSpreadAcross,
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
    expect(resolved.shadowed.map((row) => row.scope.kind)).toEqual(["runtime-host"]);
  });

  it("has nothing to resolve for a kind that has no on / off", () => {
    // A Skill, Rules, a Command and a Subagent are files: on the disk or not. There is no setting.
    for (const id of [
      "plugin:gh-review/subagent/reviewer",
      "local/skill/commit-style",
      "engine/rules/house-style",
      "local/command/scratch",
    ]) {
      const resolved = resolveEnablement(required(id), view);
      expect(resolved.ladder).toEqual([]);
      expect(resolved.effective).toBeUndefined();
      expect(resolved.winner).toBeUndefined();
    }
  });

  it("drops an MCP server enablement written at the repository", () => {
    // A cloned repository may ship the file but may never start a process on your machine.
    const resolved = resolveEnablement(required("local/mcp/repo-tools"), view);
    expect(resolved.dropped.map((entry) => entry.diagnostic._tag)).toEqual(["inadmissible"]);
    expect(resolved.dropped[0]?.row.scope.kind).toBe("workspace-input");
    // Dropped, so nothing resolves — and that is not the same as off.
    expect(resolved.effective).toBeUndefined();
  });

  it("drops a setting that references a contribution which no longer exists", () => {
    const resolved = resolveEnablement(required("plugin:granola/mcp/granola"), view);
    expect(resolved.dropped.map((entry) => entry.diagnostic._tag)).toEqual(["dangling"]);
    expect(resolved.effective).toBeUndefined();
  });

  it("ignores rows belonging to a workspace that is not in view", () => {
    const other = { workspaceId: "ws_nothing" as WorkspaceId };
    const resolved = resolveEnablement(required("plugin:linear/mcp/linear"), other);
    // The overlay row belongs to another workspace, so the profile row wins here.
    expect(resolved.effective).toBe(true);
    expect(resolved.winner?.scope.kind).toBe("runtime-host");
  });

  it("never reconciles two contributions that share a local name", () => {
    const fromPlugin = required("plugin:linear/mcp/linear");
    const fromLocal = required("local/mcp/linear");
    expect(fromPlugin.localName).toBe(fromLocal.localName);
    expect(fromPlugin.id).not.toBe(fromLocal.id);
    // Same name, opposite answers, and cogwork keeps them apart rather than merging them.
    expect(resolveEnablement(fromPlugin, view).effective).toBe(false);
    expect(resolveEnablement(fromLocal, view).effective).toBe(true);
  });
});

describe("cellPermitted and hasToggle", () => {
  it("gives an on / off only to the kinds that start something", () => {
    // Wanting a process installed but not running is a real position; wanting a file present but
    // ignored is not.
    expect(hasToggle("mcp-server")).toBe(true);
    expect(hasToggle("hook")).toBe(true);
    for (const kind of ["skill", "rules", "command", "subagent"] as const) {
      expect(hasToggle(kind)).toBe(false);
    }
  });

  it("puts no Scope at all behind a kind that has no on / off", () => {
    for (const kind of ["skill", "rules", "command", "subagent"] as const) {
      for (const scope of scopeOrder) expect(cellPermitted(kind, scope)).toBe(false);
    }
  });

  it("keeps the repository out of the two that do", () => {
    // A repository you cloned must not start a process on your machine.
    for (const kind of ["hook", "mcp-server"] as const) {
      expect(cellPermitted(kind, "runtime-host")).toBe(true);
      expect(cellPermitted(kind, "private-overlay")).toBe(true);
      expect(cellPermitted(kind, "workspace-input")).toBe(false);
    }
  });
});

describe("the fixture itself", () => {
  it("covers every contribution kind cogwork can run today", () => {
    // Five of the six. Hooks are out of scope for this map, so the fixture holds none and the
    // facet says so rather than showing an empty list.
    const kinds = new Set(placeholderConfiguration.contributions.map((entry) => entry.kind));
    expect(kinds.has("hook")).toBe(false);
    expect(kinds.size).toBe(5);
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
    const skill = required("local/skill/release-notes");
    expect(skill.definedAt).toBe("workspace-input");
    expect(enableScopeFor(skill)).toBeUndefined();
  });

  it("redirects a repo-shipped MCP server to a Scope that may enable it", () => {
    const server = required("local/mcp/repo-tools");
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
    expect(mcp.definedAt).toBe("runtime-host");
    expect(enableScopeFor(mcp)?.kind).toBe("runtime-host");
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
    expect(settingsSpreadAcross(required("local/mcp/linear"), view)).toEqual([]);
  });

  it("stays empty for a kind that has no on / off to spread", () => {
    expect(settingsSpreadAcross(required("local/skill/commit-style"), view)).toEqual([]);
  });

  it("names every Scope when one identity carries a value in more than one", () => {
    // The exception ADR 0013's direction exists for. It is a badge, not the shape of the page.
    const spread = settingsSpreadAcross(required("plugin:linear/mcp/linear"), view);
    expect(spread).toEqual(["private-overlay", "runtime-host"]);
  });
});
