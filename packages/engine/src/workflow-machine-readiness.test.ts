import { ConnectionOverview, NeedIdentity } from "@cogwork/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { ConnectionStore } from "./connection";
import { HarnessReadinessCache } from "./harness-readiness";
import { readOnlyRegistry, WorkspaceRegistry } from "./registry";
import { MachineReadinessSource, layer as machineReadinessLayer } from "./workflow-machine-readiness";

const overview = Schema.decodeSync(ConnectionOverview)({
  connections: [
    {
      system: "github",
      connection: {
        id: "github/taylorfsteele",
        system: "github",
        account: "taylorfsteele",
        status: "established",
      },
      readiness: { _tag: "Ready" },
    },
    {
      system: "linear",
      connection: { id: "linear/acme", system: "linear", account: "acme", status: "established" },
      readiness: { _tag: "NotReady", reason: "Connection needs re-connect" },
    },
    { system: "slack", connection: null, readiness: { _tag: "NotReady", reason: "Not connected" } },
  ],
});

const githubNeed = Schema.decodeSync(NeedIdentity)("github/taylorfsteele");

const dependencies = Layer.mergeAll(
  Layer.succeed(ConnectionStore, {
    overview: Effect.succeed(overview),
    find: () => Effect.die("unexpected Connection read"),
    findSystem: () => Effect.die("unexpected Connection read"),
    bearer: () => Effect.die("unexpected credential read"),
    readiness: () => Effect.die("unexpected Connection read"),
    requireReady: () => Effect.die("unexpected Connection requirement"),
    requireSystemReady: () => Effect.die("unexpected Connection requirement"),
    establish: () => Effect.die("unexpected Connection establishment"),
    revoke: () => Effect.void,
    remove: () => Effect.void,
  }),
  Layer.succeed(WorkspaceRegistry, readOnlyRegistry({ workspaces: [], failures: [] })),
  Layer.mock(HarnessReadinessCache, {
    readiness: () => Effect.succeed({ harnesses: [], checkedAtMillis: 0 }),
  }),
);

it.effect("reports each ready Connection as a ready need", () =>
  Effect.gen(function* () {
    const source = yield* MachineReadinessSource;
    const machine = yield* source.current;

    assert.deepStrictEqual(machine.readyNeeds, [githubNeed]);
  }).pipe(Effect.provide(machineReadinessLayer.pipe(Layer.provide(dependencies)))),
);
