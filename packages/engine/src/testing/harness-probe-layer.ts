import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { ContextAssembler, ContextAssemblerError } from "../context-assembler";
import * as CredentialStore from "../credential-store";
import * as Harness from "../harness";

/**
 * Probing a Harness never assembles a context, so this double refuses rather than pretending. It
 * exists because `HarnessRunnerEnv` is declared for every runner method at once: reading readiness
 * carries the requirements of running a turn even though it touches none of them.
 */
const refusingContextAssembler = Layer.succeed(ContextAssembler, {
  assemble: () =>
    Effect.fail(
      new ContextAssemblerError({
        source: "harnessProbeTestLayer",
        message: "a harness probe does not assemble a run context",
      }),
    ),
  cleanup: () => Effect.void,
});

/**
 * The environment `Harness.readiness` and `Harness.catalog` demand, for a test that builds the
 * daemon's handlers layer by hand. Production gets the same services from `engineLayer`.
 */
export const harnessProbeTestLayer = (runners: ReadonlyArray<Harness.HarnessRunner> = []) =>
  Layer.mergeAll(
    Harness.layer(runners),
    CredentialStore.layerEnv,
    FileSystem.layerNoop({}),
    FetchHttpClient.layer,
    refusingContextAssembler,
  );
