import type { DesktopProcessHealthSample } from "@cogwork/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";

import {
  recordDaemonEventsApplied,
  recordProtocolInboxChange,
  reportDesktopProcessHealth,
  resetProtocolInboxDepth,
} from "./process-health";

const samples = [
  {
    process: "main",
    sampledAtMillis: 1_000,
    heapUsedBytes: 400,
  },
  {
    process: "renderer",
    sampledAtMillis: 1_000,
    heapUsedBytes: 200,
  },
] satisfies ReadonlyArray<DesktopProcessHealthSample>;

describe("desktop process health reporter", () => {
  it("enriches renderer samples with protocol activity", async () => {
    recordProtocolInboxChange(2);
    recordDaemonEventsApplied(5);

    const current = await Effect.runPromise(
      Effect.gen(function* () {
        const reported = yield* Deferred.make<ReadonlyArray<DesktopProcessHealthSample>>();
        yield* reportDesktopProcessHealth(
          () => Promise.resolve(samples),
          (next) => Deferred.succeed(reported, next).pipe(Effect.asVoid),
        ).pipe(Effect.forkScoped);
        return yield* Deferred.await(reported);
      }).pipe(Effect.scoped),
    );

    const renderer = current.find((sample) => sample.process === "renderer");
    expect(renderer?.protocolInboxDepth).toBe(2);
    resetProtocolInboxDepth();
  });
});
