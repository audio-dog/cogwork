import { Connection, connectionIdOf } from "@cogwork/contracts";
import { describe, expect, it } from "vitest";
import { connectionItems, trackerSelectionPatch } from "./workspace-setting-rows";

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

    expect(connectionItems([github, linear], "github")).toEqual([{ value: github.id, label: "acme" }]);
    expect(connectionItems([], "github")).toEqual([]);
  });

  it("replaces the Connection when the tracker system changes", () => {
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

    expect(trackerSelectionPatch([github, linear], "linear")).toEqual({
      issueTrackerType: "linear",
      issueTrackerConnectionId: linear.id,
    });
    expect(trackerSelectionPatch([github], "linear")).toEqual({
      issueTrackerType: "linear",
      issueTrackerConnectionId: "unbound",
    });
  });
});
