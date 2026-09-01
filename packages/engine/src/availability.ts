import { AvailabilityCause, type LifecycleStage, type OperationAvailability } from "@cogwork/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import type { RegisteredWorkspace } from "./projector";

interface AvailabilityEntry {
  readonly fingerprint: string;
  readonly recordedAtMillis: number;
  readonly availability: OperationAvailability;
}

const failureTtlMillis = 60_000;

const workspaceFingerprint = (workspace: RegisteredWorkspace) =>
  JSON.stringify({ config: workspace.config, contributions: workspace.contributions });

const entryKey = (workspace: RegisteredWorkspace, operation: LifecycleStage) =>
  `${workspace.config.name}:${operation}`;

export const availabilityCauseSummary = (cause: AvailabilityCause) =>
  AvailabilityCause.match(cause, {
    UnsatisfiedNeed: ({ kind, reason }) => `Required ${kind} need is ${reason}.`,
    RuntimeHostFactFailed: ({ fact }) => `Runtime host fact ${fact} failed.`,
    PolicyRefusal: () => "Operation policy refused execution.",
  });

export const make = Effect.gen(function* () {
  const entries = yield* Ref.make<ReadonlyMap<string, AvailabilityEntry>>(new Map());

  const current = Effect.fn("Availability.current")(function* (workspace: RegisteredWorkspace) {
    const now = yield* Clock.currentTimeMillis;
    const fingerprint = workspaceFingerprint(workspace);
    return [...(yield* Ref.get(entries)).values()]
      .filter((entry) => entry.fingerprint === fingerprint)
      .filter((entry) => entry.availability.available || now - entry.recordedAtMillis < failureTtlMillis)
      .map(({ availability }) => availability);
  });

  const record = Effect.fn("Availability.record")(function* (
    workspace: RegisteredWorkspace,
    availability: OperationAvailability,
  ) {
    const recordedAtMillis = yield* Clock.currentTimeMillis;
    const entry: AvailabilityEntry = {
      fingerprint: workspaceFingerprint(workspace),
      recordedAtMillis,
      availability,
    };
    yield* Ref.update(entries, (current) =>
      new Map(current).set(entryKey(workspace, availability.operation), entry),
    );
  });

  const invalidate = Effect.fn("Availability.invalidate")(function* (workspace?: RegisteredWorkspace) {
    yield* Ref.update(entries, (current) => {
      if (!workspace) return new Map();
      const prefix = `${workspace.config.name}:`;
      return new Map([...current].filter(([key]) => !key.startsWith(prefix)));
    });
  });

  return { current, record, invalidate };
});

export class Availability extends Context.Service<Availability, Effect.Success<typeof make>>()(
  "@cogwork/engine/availability",
) {
  static readonly layer = Layer.effect(Availability, make);
}
