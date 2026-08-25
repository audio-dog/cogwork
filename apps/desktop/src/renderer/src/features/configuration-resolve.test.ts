import { describe, expect, it } from "vitest";
import type { Contribution, ScopeRef, WorkspaceId } from "./configuration-model";
import { cogworkWorkspaceId, contributionById, placeholderConfiguration } from "./configuration-placeholder";
import {
  cellPermitted,
  collectAttention,
  resolveEnablement,
  resolveOperationSetting,
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

  it("drops a Hook enablement written at the Workspace input Scope", () => {
    const resolved = resolveEnablement(required("plugin:gh-review/hook/pre-push"), view);
    expect(resolved.dropped.map((entry) => entry.diagnostic._tag)).toEqual(["inadmissible"]);
    expect(resolved.dropped[0]?.row.scope.kind).toBe("workspace-input");
    // The admissible profile row still resolves, so one bad line does not stop the work.
    expect(resolved.effective).toBe(true);
    expect(resolved.winner?.scope.kind).toBe("runtime-host");
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
    placeholderConfiguration.plugins,
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

  it("surfaces a staged update but not an available one", () => {
    const updates = items.filter((item) => item.id.startsWith("update:"));
    expect(updates.map((item) => item.id)).toEqual(["update:GitHub review pack"]);
  });
});

describe("the fixture itself", () => {
  it("puts every contribution kind on screen", () => {
    const kinds = new Set(placeholderConfiguration.contributions.map((entry) => entry.kind));
    expect(kinds.size).toBe(6);
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
