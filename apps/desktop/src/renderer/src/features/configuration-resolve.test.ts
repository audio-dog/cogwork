import { describe, expect, it } from "vitest";
import { type Contribution, type ScopeRef, scopeOrder, type WorkspaceId } from "./configuration-model";
import { cogworkWorkspaceId, contributionById, placeholderConfiguration } from "./configuration-placeholder";
import {
  cellPermitted,
  collectAttention,
  enableScopeFor,
  offeredElsewhere,
  resolveEnablement,
  resolveOperationSetting,
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
    const resolved = resolveEnablement(required("plugin:gh-review/skill/pr-summary"), view);
    expect(resolved.effective).toBe(false);
    expect(resolved.winner?.scope.kind).toBe("private-overlay");
    expect(resolved.shadowed.map((row) => row.scope.kind)).toEqual(["runtime-host"]);
  });

  it("leaves the effective value absent when nothing is written — not false", () => {
    const resolved = resolveEnablement(required("plugin:gh-review/subagent/reviewer"), view);
    expect(resolved.effective).toBeUndefined();
    expect(resolved.winner).toBeUndefined();
    expect(resolved.shadowed).toEqual([]);
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
    const resolved = resolveEnablement(required("plugin:gh-review/skill/pr-summary"), other);
    // The overlay row belongs to another workspace, so the profile row wins here.
    expect(resolved.effective).toBe(true);
    expect(resolved.winner?.scope.kind).toBe("runtime-host");
  });

  it("never reconciles two contributions that share a local name", () => {
    const fromPlugin = required("plugin:linear/mcp/linear");
    const fromLocal = required("local/mcp/linear");
    expect(fromPlugin.localName).toBe(fromLocal.localName);
    expect(fromPlugin.id).not.toBe(fromLocal.id);
    expect(resolveEnablement(fromPlugin, view).winner?.scope.kind).toBe("runtime-host");
    expect(resolveEnablement(fromLocal, view).winner?.scope.kind).toBe("private-overlay");
  });
});

describe("cellPermitted", () => {
  it("excludes the Workspace input for the executable kinds", () => {
    expect(cellPermitted("hook", "workspace-input")).toBe(false);
    expect(cellPermitted("mcp-server", "workspace-input")).toBe(false);
    expect(cellPermitted("skill", "workspace-input")).toBe(true);
  });

  it("lets the Runtime host hold every contribution kind", () => {
    const kinds = ["hook", "mcp-server", "skill", "rules", "command", "subagent"] as const;
    // The machine is where a contribution's file lives, so it is the bottom rung for all six.
    for (const kind of kinds) expect(cellPermitted(kind, "runtime-host")).toBe(true);
  });
});

describe("resolveOperationSetting", () => {
  it("consults the level before the Scope", () => {
    const implement = placeholderConfiguration.operations.find((entry) => entry.id === "implement");
    if (!implement) throw new Error("fixture is missing the implement Operation");
    const resolved = resolveOperationSetting(implement, "model", view);
    // The Operation-level value wins over the default even though both are admissible Scopes.
    expect(resolved.value).toBe("claude-opus-5");
    expect(resolved.winner?.level).toBe("operation");
    expect(resolved.shadowed.map((row) => row.level)).toEqual(["default"]);
  });

  it("reports a locked setting and the source that refused the override", () => {
    const implement = placeholderConfiguration.operations.find((entry) => entry.id === "implement");
    if (!implement) throw new Error("fixture is missing the implement Operation");
    const resolved = resolveOperationSetting(implement, "permission-profile", view);
    expect(resolved.locked).toBe(true);
    expect(resolved.refusedBy).toContain("locks permission-profile");
  });

  it("takes harness at the Runtime host", () => {
    const triage = placeholderConfiguration.operations.find((entry) => entry.id === "triage");
    if (!triage) throw new Error("fixture is missing the triage Operation");
    const harness = resolveOperationSetting(triage, "harness", view);
    expect(harness.winner?.scope.kind).toBe("runtime-host");
  });
});

describe("collectAttention", () => {
  const items = collectAttention(
    placeholderConfiguration.contributions,
    placeholderConfiguration.operations,
    view,
  );

  it("surfaces a failed load as an error", () => {
    expect(
      items.some((item) => item.id === "load:plugin:granola/mcp/granola" && item.severity === "error"),
    ).toBe(true);
  });

  it("surfaces every unmet need as its own item", () => {
    const needs = items.filter((item) => item.id.startsWith("need:"));
    expect(needs.map((item) => item.id).toSorted()).toEqual([
      "need:follow-up:pr-summary",
      "need:verify:test-runner",
    ]);
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
  it("turns a thing on where it lives, for the ordinary case", () => {
    const skill = required("local/skill/release-notes");
    expect(skill.definedAt).toBe("workspace-input");
    // A Skill may be enabled at the repo, so nothing is redirected.
    expect(enableScopeFor(skill)?.kind).toBe("workspace-input");
    expect(offeredElsewhere(skill)).toBe(false);
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
    expect(settingsSpreadAcross(required("plugin:linear/mcp/linear"), view)).toEqual([]);
  });

  it("names every Scope when one identity carries a value in more than one", () => {
    // The exception ADR 0013's direction exists for. It is a badge, not the shape of the page.
    const spread = settingsSpreadAcross(required("plugin:gh-review/skill/pr-summary"), view);
    expect(spread).toEqual(["private-overlay", "runtime-host"]);
  });
});
