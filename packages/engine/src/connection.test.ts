import { Connection, type ConnectionReadiness, connectionIdOf } from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import { connectionOverview, requiringPluginId } from "./connection";

const github = Connection.make({
  id: connectionIdOf("github", "default"),
  system: "github",
  account: "default",
  status: "established",
});

describe("Connection overview", () => {
  it("renders an established Connection with no Plugin as ready", () => {
    const overview = connectionOverview(
      [github],
      { plugins: [] },
      new Map([[github.id, { _tag: "Ready" } satisfies ConnectionReadiness]]),
    );

    const card = overview.connections.find((item) => item.system === "github");
    assert.strictEqual(card?.connection?.id, "github/default");
    assert.strictEqual(card?.readiness._tag, "Ready");
    assert.isNull(card?.pluginId ?? null);
  });

  it("derives the one Plugin requiring a system", () => {
    assert.strictEqual(
      requiringPluginId(
        {
          plugins: [
            {
              pluginId: "linear",
              name: "Linear",
              summary: "Linear tools",
              record: null,
              resolvedIdentity: "linear@1",
              requiredConnections: ["linear"],
              contributions: [],
              manifestFailure: null,
            },
          ],
        },
        "linear",
      ),
      "linear",
    );
  });
});
