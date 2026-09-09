import type { HarnessEnablement, HarnessName } from "@cogwork/contracts";
import {
  HarnessItem,
  type HarnessOptionCatalog,
  HarnessOverview,
  HarnessSignIn,
  HarnessState,
  harnessEnabled,
} from "@cogwork/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import { Harness, type HarnessError, type HarnessReadiness, type HarnessService } from "./harness";

// Reading readiness spawns the Harness's CLI; each runner also bounds its own probe.
const probeDeadline = "10 seconds";

// `TrimmedNonEmptyString` rejects a blank, and a harness can report one.
const diagnostic = (message: string) => message.trim() || "the harness gave no reason";

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

const unreachable = (name: HarnessName, enabled: boolean, message: string) =>
  HarnessItem.make({
    harness: name,
    enabled,
    version: null,
    state: HarnessState.cases.Unknown.make({ diagnostic: diagnostic(message) }),
    models: [],
    catalog: null,
  });

const overviewItem = Effect.fn("Harness.overviewItem")(function* (
  harness: HarnessService,
  name: HarnessName,
  enabled: boolean,
) {
  const readiness = yield* harness.readiness(name);
  const catalog = yield* harness
    .catalog(name)
    .pipe(Effect.catchTag("HarnessError", () => Effect.succeed<HarnessOptionCatalog | null>(null)));
  return HarnessItem.make({
    harness: name,
    enabled,
    version: readiness.installation.version,
    state: harnessStateOf(readiness, harness.signIn(name)),
    models: catalog?.models.map((choice) => choice.value) ?? [],
    catalog,
  });
});

export const harnessOverview = Effect.fn("Harness.overview")(function* (
  settings: ReadonlyArray<HarnessEnablement> = [],
) {
  const harness = yield* Harness;
  const harnesses = yield* Effect.forEach(
    harness.names,
    (name) => {
      const enabled = harnessEnabled(settings, name);
      return overviewItem(harness, name, enabled).pipe(
        Effect.timeout(probeDeadline),
        Effect.catchTags({
          TimeoutError: () =>
            Effect.succeed(unreachable(name, enabled, `the probe overran ${probeDeadline}`)),
          HarnessError: (error: HarnessError) => Effect.succeed(unreachable(name, enabled, error.message)),
        }),
      );
    },
    { concurrency: "unbounded" },
  );
  return HarnessOverview.make({ harnesses, checkedAtMillis: yield* Clock.currentTimeMillis });
});
