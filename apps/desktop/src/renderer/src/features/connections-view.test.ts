import { Connection, type ConnectionItem, connectionIdOf } from "@cogwork/contracts";
import { describe, expect, it } from "vitest";
import {
  connectionAction,
  connectionStatus,
  connectionSystemLabel,
  pluginRequiring,
  workspaceConnectionChoices,
} from "./connections-view";

const item = (over: Partial<ConnectionItem>): ConnectionItem => ({
  system: "linear",
  connection: null,
  readiness: { _tag: "NotReady", reason: "Not connected" },
  ...over,
});

describe("Connections view", () => {
  it("labels Granola in the read model", () => {
    expect(connectionSystemLabel("granola")).toBe("Granola");
  });

  it("presents establish, ready, and re-connect states", () => {
    expect(connectionStatus(item({})).label).toBe("Not connected");
    expect(connectionAction(item({}))).toBe("establish");
    expect(
      connectionAction(
        item({
          connection: {
            id: connectionIdOf("linear", "acme"),
            system: "linear",
            account: "acme",
            status: "established",
          },
          readiness: { _tag: "Ready" },
        }),
      ),
    ).toBe("none");
    expect(
      connectionStatus(
        item({
          connection: {
            id: connectionIdOf("linear", "acme"),
            system: "linear",
            account: "acme",
            status: "established",
          },
          readiness: { _tag: "Ready" },
        }),
      ),
    ).toEqual({ label: "Connected", tone: "positive" });
    expect(
      connectionAction(
        item({
          connection: {
            id: connectionIdOf("linear", "acme"),
            system: "linear",
            account: "acme",
            status: "revoked",
          },
        }),
      ),
    ).toBe("re-connect");
  });

  it("names the one Plugin that requires the system, or none", () => {
    const plugin = (pluginId: string, requires: "github" | "linear") => ({
      pluginId,
      name: pluginId,
      summary: pluginId,
      record: null,
      resolvedIdentity: pluginId,
      requiredConnections: [requires] as const,
      contributions: [],
      manifestFailure: null,
    });
    const overview = { plugins: [plugin("linear", "linear")] };
    expect(pluginRequiring(overview, "linear")?.pluginId).toBe("linear");
    // The shipped GitHub Plugin requires no Connection; the Engine's own ports use that one.
    expect(pluginRequiring(overview, "github")).toBeNull();
    expect(pluginRequiring({ plugins: [] }, "linear")).toBeNull();
  });

  it("keeps only the selected unavailable workspace binding visible", () => {
    const selectedConnection = Connection.make({
      id: connectionIdOf("linear", "selected"),
      system: "linear",
      account: "selected",
      status: "revoked",
    });
    const hiddenConnection = Connection.make({
      id: connectionIdOf("linear", "hidden"),
      system: "linear",
      account: "hidden",
      status: "revoked",
    });
    const readyConnection = Connection.make({
      id: connectionIdOf("linear", "ready"),
      system: "linear",
      account: "ready",
      status: "established",
    });
    const selected = item({
      connection: selectedConnection,
    });
    const hidden = item({
      connection: hiddenConnection,
    });
    const ready = item({
      connection: readyConnection,
      readiness: { _tag: "Ready" },
    });

    expect(
      workspaceConnectionChoices({ connections: [selected, hidden, ready] }, [selectedConnection.id]),
    ).toEqual([selectedConnection, readyConnection]);
  });
});
