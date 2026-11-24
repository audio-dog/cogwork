import { Connection, connectionIdOf } from "@cogwork/contracts";
import { describe, expect, it } from "vitest";

import {
  assigneeItems,
  connectionItems,
  sourceControlSelectionPatch,
  trackerSelectionPatch,
  unloadedAssigneeItems,
} from "./workspace-setting-rows";

describe("workspace Connection choices", () => {
  it("offers established Connections without an unbound choice", () => {
    const github = Connection.make({
      id: connectionIdOf("github", "acme"),
      system: "github",
      account: "acme",
      status: "established",
    });
    const linear = Connection.make({
      id: connectionIdOf("linear", "acme"),
      system: "linear",
      account: "acme",
      status: "established",
    });
    const revoked = Connection.make({
      id: connectionIdOf("github", "revoked"),
      system: "github",
      account: "revoked",
      status: "revoked",
    });

    expect(connectionItems([github, revoked, linear], "github")).toEqual([
      { value: github.id, label: "acme", disabled: false },
      { value: revoked.id, label: "revoked", disabled: true },
    ]);
    expect(connectionItems([], "github")).toEqual([]);
  });

  it("replaces the Connection and clears the assignee allowlist when the tracker system changes", () => {
    const github = Connection.make({
      id: connectionIdOf("github", "acme"),
      system: "github",
      account: "acme",
      status: "established",
    });
    const linear = Connection.make({
      id: connectionIdOf("linear", "acme"),
      system: "linear",
      account: "acme",
      status: "established",
    });
    const revokedLinear = Connection.make({
      id: connectionIdOf("linear", "revoked"),
      system: "linear",
      account: "revoked",
      status: "revoked",
    });

    expect(trackerSelectionPatch([github, revokedLinear, linear], "linear")).toEqual({
      issueTrackerType: "linear",
      issueTrackerConnectionId: linear.id,
      assigneeAllowlist: [],
    });
    expect(trackerSelectionPatch([github, revokedLinear], "linear")).toEqual({
      issueTrackerType: "linear",
      issueTrackerConnectionId: "unbound",
      assigneeAllowlist: [],
    });
  });

  it("replaces the Connection when the source control provider changes", () => {
    const github = Connection.make({
      id: connectionIdOf("github", "acme"),
      system: "github",
      account: "acme",
      status: "established",
    });
    const revokedGithub = Connection.make({
      id: connectionIdOf("github", "revoked"),
      system: "github",
      account: "revoked",
      status: "revoked",
    });

    expect(sourceControlSelectionPatch([revokedGithub, github], "github")).toEqual({
      sourceControlType: "github",
      sourceControlConnectionId: github.id,
    });
    expect(sourceControlSelectionPatch([revokedGithub], "github")).toEqual({
      sourceControlType: "github",
      sourceControlConnectionId: "unbound",
    });
    expect(sourceControlSelectionPatch([github], "none")).toEqual({
      sourceControlType: "none",
      sourceControlConnectionId: "unbound",
    });
  });
});

describe("assignee allowlist choices", () => {
  const ada = { identity: "0b6d9c1e-7a2f-4c3d-9e8b-1a2b3c4d5e6f", label: "Ada Lovelace" };

  it("marks a stored identity the loaded people list lacks as unknown so it can be removed", () => {
    expect(assigneeItems([ada], ["taylor.steele", ada.identity])).toEqual([
      { identity: "taylor.steele", label: "Unknown: taylor.steele" },
      ada,
    ]);
  });

  it("does not call a stored identity unknown while the people list has not loaded", () => {
    expect(unloadedAssigneeItems([ada.identity])).toEqual([{ identity: ada.identity, label: ada.identity }]);
  });
});
