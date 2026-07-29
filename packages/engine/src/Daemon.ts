import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { DaemonRpcs } from "./Protocol";
import { WorkspaceRegistry } from "./Registry";

export class DaemonInfo extends Context.Service<DaemonInfo, { readonly startedAtMillis: number }>()(
  "engine/Daemon/DaemonInfo",
) {}

export const daemonInfoLayer = Layer.effect(
  DaemonInfo,
  Effect.map(Clock.currentTimeMillis, (startedAtMillis) => ({ startedAtMillis })),
);

export const handlersLayer = DaemonRpcs.toLayer({
  GetStatus: () =>
    Effect.gen(function* () {
      const registry = yield* WorkspaceRegistry;
      const info = yield* DaemonInfo;
      const now = yield* Clock.currentTimeMillis;
      return {
        health: "running" as const,
        startedAtMillis: info.startedAtMillis,
        uptimeMillis: now - info.startedAtMillis,
        workspaces: registry.workspaces.map((w) => ({
          name: w.config.name,
          checkoutPath: w.config.checkoutPath,
          workSource: w.config.workSource.type,
          harness: w.config.harness.preferred,
        })),
        failures: registry.failures.map((f) => ({ source: f.source, message: f.message })),
      };
    }),
});

export const reconcileHeartbeat = Effect.gen(function* () {
  const registry = yield* WorkspaceRegistry;
  yield* Effect.logInfo("reconcile tick", {
    workspaces: registry.workspaces.length,
    failures: registry.failures.length,
  });
}).pipe(Effect.repeat(Schedule.spaced("5 seconds")));
