import { type ConnectionItem, connectionIdOf } from "@cogwork/contracts";
import { describe, expect, it } from "vitest";
import {
  connectionAction,
  connectionPluginLabel,
  connectionStatus,
  readyConnections,
} from "./connections-view";

const item = (over: Partial<ConnectionItem>): ConnectionItem => ({
  system: "linear",
  connection: null,
  readiness: { _tag: "NotReady", reason: "Not connected" },
  pluginId: "linear",
  ...over,
});

describe("Connections view", () => {
  it("presents establish, ready, and re-connect states", () => {
    expect(connectionStatus(item({}))).toBe("Not connected");
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
    ).toBe("Established");
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

  it("makes a missing Plugin explicit", () => {
    expect(connectionPluginLabel(item({ pluginId: null }))).toBe("No Plugin");
    expect(connectionPluginLabel(item({ pluginId: "linear" }))).toBe("Plugin: linear");
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
    const github = item({ system: "github", pluginId: null });

    expect(readyConnections({ connections: [linear, github] })).toEqual([linear.connection]);
  });
});
