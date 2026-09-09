import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
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
// It stays its own builder: folded into `engineTestLayer`, an empty registry would shadow the
// harness double `executor.test.ts` provides, and a second `engineTestLayer` in the daemon pipe
// would hand those suites a different run ledger than the one they assert on.
export const harnessProbeTestLayer = (runners: ReadonlyArray<Harness.HarnessRunner> = []) =>
  Layer.mergeAll(
    Harness.layer(runners),
    CredentialStore.layerEnv,
    FileSystem.layerNoop({}),
    FetchHttpClient.layer,
    refusingContextAssembler,
  );
