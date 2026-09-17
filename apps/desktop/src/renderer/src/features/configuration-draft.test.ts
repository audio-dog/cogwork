import { describe, expect, it } from "vitest";
import { cogworkWorkspaceId, contributionById } from "../testing/configuration";
import { type DraftEntry, draftCellAt, draftKey, withDraft } from "./configuration-draft";
import type { Contribution, ScopeRef } from "./configuration-model";
import { resolveEnablement } from "./configuration-resolve";

const machine: ScopeRef = { kind: "settings-profile" };
const overlay: ScopeRef = { kind: "private-overlay", workspaceId: cogworkWorkspaceId };
const view = { workspaceId: cogworkWorkspaceId };

function required(id: string): Contribution {
  const contribution = contributionById(id);
  if (!contribution) throw new Error(`fixture is missing ${id}`);
  return contribution;
}

function draft(...entries: readonly (readonly [string, ScopeRef, DraftEntry["cell"]])[]) {
  return Object.fromEntries(entries.map(([id, scope, cell]) => [draftKey(id, scope), { scope, cell }]));
}

describe("withDraft", () => {
  it("returns the same contribution when nothing is edited", () => {
    const contribution = required("plugin:linear/mcp/linear");
    expect(withDraft(contribution, {})).toBe(contribution);
  });

  it("clearing a cell removes the row rather than writing false", () => {
    const contribution = required("plugin:linear/mcp/linear");
    const edited = withDraft(contribution, draft([contribution.id, overlay, "unset"]));
    expect(edited.rows.some((row) => row.scope.kind === "private-overlay")).toBe(false);
    // With the overlay's `off` cleared, the machine's `on` is what a Run gets.
    expect(resolveEnablement(edited, view).effective).toBe(true);
    expect(resolveEnablement(edited, view).winner?.scope.kind).toBe("settings-profile");
  });

  it("distinguishes clearing a cell from setting it off", () => {
    // Nothing admissible is written for this one, so it starts with no resolved value at all.
    const contribution = required("local:repo/mcp/repo-tools");
    const cleared = withDraft(contribution, draft([contribution.id, machine, "unset"]));
    const off = withDraft(contribution, draft([contribution.id, machine, "off"]));
    expect(resolveEnablement(cleared, view).effective).toBeUndefined();
    expect(resolveEnablement(off, view).effective).toBe(false);
  });

  it("replaces a written row at the same Scope instead of duplicating it", () => {
    const contribution = required("plugin:linear/mcp/linear");
    const edited = withDraft(contribution, draft([contribution.id, machine, "off"]));
    const atProfile = edited.rows.filter((row) => row.scope.kind === "settings-profile");
    expect(atProfile).toHaveLength(1);
    expect(atProfile[0]?.value).toBe(false);
  });

  it("keeps edits to one Scope from touching another", () => {
    const contribution = required("plugin:linear/mcp/linear");
    const edited = withDraft(contribution, draft([contribution.id, machine, "off"]));
    const overlayRow = edited.rows.find((row) => row.scope.kind === "private-overlay");
    expect(overlayRow?.source).toBe("Control store");
  });

  it("leaves other contributions alone", () => {
    const target = required("plugin:linear/mcp/linear");
    const other = required("local:private/mcp/linear");
    const cells = draft([target.id, machine, "off"]);
    expect(withDraft(other, cells)).toBe(other);
  });
});

describe("draftCellAt", () => {
  it("reads an unedited cell from the rows the daemon sent", () => {
    const contribution = required("plugin:linear/mcp/linear");
    expect(draftCellAt(contribution, machine, {})).toBe("on");
    expect(draftCellAt(contribution, overlay, {})).toBe("off");
  });

  it("reports an absent cell as unset", () => {
    // A Subagent has no on / off anywhere, so every cell reads unset.
    const contribution = required("plugin:gh-review/subagent/reviewer");
    expect(draftCellAt(contribution, machine, {})).toBe("unset");
    expect(draftCellAt(contribution, overlay, {})).toBe("unset");
  });

  it("prefers the edit over the written row", () => {
    const contribution = required("plugin:linear/mcp/linear");
    const cells = draft([contribution.id, machine, "unset"]);
    expect(draftCellAt(contribution, machine, cells)).toBe("unset");
  });
});
