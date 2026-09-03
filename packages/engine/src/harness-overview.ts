import type { HarnessName } from "@cogwork/contracts";
import { HarnessItem, HarnessOverview, HarnessSignIn, HarnessState } from "@cogwork/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import { Harness, type HarnessError, type HarnessReadiness, type HarnessService } from "./harness";

/**
 * Reading one Harness's readiness spawns that Harness's CLI. Each runner already bounds its own
 * probe; this bound is the backstop that stops one hung child from holding the whole answer.
 */
const probeDeadline = "10 seconds";

/** `TrimmedNonEmptyString` rejects a blank, and a diagnostic is the one field that might be one. */
const diagnostic = (message: string) => message.trim() || "the harness gave no reason";

/**
 * Fold the four observed axes into the one conclusion a client shows, in the order a person can act
 * on them: not installed, wrong version, not signed in, then whatever is left. Exported for its own
 * tests.
 */
export const harnessStateOf = (readiness: HarnessReadiness, signIn: string | null): HarnessState => {
  if (readiness.installation.status === "missing") {
    return HarnessState.cases.NotInstalled.make({
      diagnostic: diagnostic(readiness.operational.diagnostic),
    });
  }
  if (readiness.compatibility.status === "incompatible") {
    return HarnessState.cases.UnsupportedVersion.make({
      requirement: readiness.compatibility.requirement,
    });
  }
  if (readiness.authentication.status === "unavailable") {
    return HarnessState.cases.NotSignedIn.make({
      signIn: signIn ? HarnessSignIn.make({ command: signIn }) : null,
    });
  }
  if (readiness.operational.status === "ready") return HarnessState.cases.Ready.make({});
  if (readiness.operational.status === "unknown") {
    return HarnessState.cases.Unknown.make({ diagnostic: diagnostic(readiness.operational.diagnostic) });
  }
  return HarnessState.cases.Unavailable.make({
    diagnostic: diagnostic(readiness.operational.diagnostic),
  });
};

const unknownState = (message: string) =>
  HarnessState.cases.Unknown.make({ diagnostic: diagnostic(message) });

/**
 * One Harness's row. Nothing here fails: a probe that errors or overruns becomes an `Unknown` state
 * for that Harness, so the other rows still reach the client.
 */
const overviewItem = Effect.fn("Harness.overviewItem")(function* (
  harness: HarnessService,
  name: HarnessName,
) {
  const probe = yield* harness.readiness(name).pipe(
    Effect.map((readiness) => ({
      version: readiness.installation.version,
      state: harnessStateOf(readiness, harness.signIn(name)),
    })),
    Effect.timeout(probeDeadline),
    Effect.catchTags({
      TimeoutError: () =>
        Effect.succeed({
          version: null,
          state: unknownState(`the readiness probe overran ${probeDeadline}`),
        }),
      HarnessError: (error: HarnessError) =>
        Effect.succeed({ version: null, state: unknownState(error.message) }),
    }),
  );
  // A catalog no source can answer is an empty model list, not a failure: the state already says why.
  const models = yield* harness.catalog(name).pipe(
    Effect.map((catalog) => catalog.models.map((choice) => choice.value)),
    Effect.timeout(probeDeadline),
    Effect.orElseSucceed((): ReadonlyArray<string> => []),
  );
  return HarnessItem.make({ harness: name, version: probe.version, state: probe.state, models });
});

/** Every registered Harness's readiness and models, as of now. */
export const harnessOverview = Effect.fn("Harness.overview")(function* () {
  const harness = yield* Harness;
  const harnesses = yield* Effect.forEach(harness.names, (name) => overviewItem(harness, name), {
    concurrency: "unbounded",
  });
  return HarnessOverview.make({ harnesses, checkedAtMillis: yield* Clock.currentTimeMillis });
});
