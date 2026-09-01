import { type ConnectionItem, connectionIdOf } from "@cogwork/contracts";
import { describe, expect, it } from "vitest";
import { connectionAction, connectionStatus, pluginRequiring, readyConnections } from "./connections-view";

const item = (over: Partial<ConnectionItem>): ConnectionItem => ({
  system: "linear",
  connection: null,
  readiness: { _tag: "NotReady", reason: "Not connected" },
  ...over,
});

describe("Connections view", () => {
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

  it("selects ready workspace bindings from the Connection overview", () => {
    const linear = item({
      connection: {
        id: connectionIdOf("linear", "acme"),
        system: "linear",
        account: "acme",
        status: "established",
      },
      readiness: { _tag: "Ready" },
    });
    const github = item({ system: "github" });

    expect(readyConnections({ connections: [linear, github] })).toEqual([linear.connection]);
  });
});
