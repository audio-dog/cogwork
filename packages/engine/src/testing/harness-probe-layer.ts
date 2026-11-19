import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import { ContextAssembler, ContextAssemblerError } from "../context-assembler";
import * as CredentialStore from "../credential-store";
import * as Harness from "../harness";

/** Probing never assembles a context, so this refuses rather than pretending to. */
const refusingContextAssembler = Layer.succeed(ContextAssembler, {
  assemble: () =>
    Effect.fail(
      new ContextAssemblerError({
        source: "harnessProbeTestLayer",
        message: "a harness probe does not assemble a run context",
        retryable: false,
      }),
    ),
  cleanup: () => Effect.void,
});

// `HarnessRunnerEnv` is declared for every runner method at once, so a probe demands all of it.
// It stays its own builder: folded into `engineTestLayer`, an empty registry would shadow a suite's
// own harness double, and a second `engineTestLayer` in the daemon pipe would hand those suites a
// different run ledger than the one they assert on.
export const harnessProbeTestLayer = (
  runners: ReadonlyArray<Harness.HarnessRunner> = [],
  credentials: Layer.Layer<CredentialStore.CredentialStore> = CredentialStore.layerEnv,
) =>
  Layer.mergeAll(
    Harness.layer(runners),
    credentials,
    FileSystem.layerNoop({}),
    FetchHttpClient.layer,
    refusingContextAssembler,
  );
