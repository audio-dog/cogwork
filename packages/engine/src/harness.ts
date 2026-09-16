import {
  type AgUiEvent,
  type HarnessCatalogChoice as ContractHarnessCatalogChoice,
  type HarnessCatalogModel as ContractHarnessCatalogModel,
  type HarnessCatalogProvenance as ContractHarnessCatalogProvenance,
  type HarnessModelOption as ContractHarnessModelOption,
  type HarnessOptionCatalog as ContractHarnessOptionCatalog,
  effortOptionId,
  type HarnessName,
  type OperationModelOption,
  type RunPlan,
  type RunPlanMember,
  type RunPlanMiddlewareName,
  type SessionId,
  type SessionKind,
  type StageResultJsonSchema,
  stageResultJsonSchema,
} from "@cogwork/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type * as Path from "effect/Path";
import type * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import type { ContextAssembler } from "./context-assembler";
import type { CredentialStore } from "./credential-store";
import type { ResolvedMcpSkill } from "./mcp-skill";
import type { OperationPolicyProfile } from "./operation-policy";
import type { SessionStore } from "./session-store";

export type { AgUiEvent } from "@cogwork/contracts";
export type { ResolvedMcpSkill } from "./mcp-skill";
export type { OperationPolicyProfile } from "./operation-policy";

export const stageResultSchema = stageResultJsonSchema;
export type StageResultSchema = StageResultJsonSchema;

export interface HarnessRequest {
  readonly plan: RunPlan;
  readonly session: SessionId | null;
  readonly mcpCredentials: ReadonlyMap<string, Redacted.Redacted<string>>;
}

export const resolvedMcpSkills = (request: HarnessRequest): ReadonlyArray<ResolvedMcpSkill> =>
  request.plan.mcp.flatMap((server) =>
    "endpoint" in server && server.unavailableReason === null
      ? [
          {
            name: server.projectedName,
            endpoint: server.endpoint,
            bearer: request.mcpCredentials.get(server.identity) ?? null,
          },
        ]
      : [],
  );

export interface HarnessExecution {
  readonly nonInteractive: boolean;
  readonly worktreeConfined: boolean;
  readonly profiles: ReadonlyArray<OperationPolicyProfile>;
}

export type HarnessCatalogChoice = ContractHarnessCatalogChoice;

export type HarnessModelOption = ContractHarnessModelOption;

export type HarnessCatalogModel = ContractHarnessCatalogModel;

export interface HarnessCatalogOptions {
  readonly models: ReadonlyArray<HarnessCatalogModel>;
  readonly efforts?: ReadonlyArray<HarnessCatalogChoice>;
}

export type HarnessCatalogProvenance = ContractHarnessCatalogProvenance;

export interface HarnessCatalogSourceResult extends HarnessCatalogOptions {
  readonly provenance: HarnessCatalogProvenance;
}

export type HarnessOptionCatalog = ContractHarnessOptionCatalog;

export interface HarnessCatalogSource {
  readonly catalog: Effect.Effect<HarnessCatalogSourceResult | null, HarnessError, HarnessRunnerEnv>;
}

export interface HarnessCatalogSources {
  readonly runtime?: HarnessCatalogSource;
  readonly native?: HarnessCatalogSource;
  readonly fallback: HarnessCatalogSource;
}

export type HarnessAuthenticationMode = "host" | "byok";
export type HarnessHumanAttach = "codex-cli" | false;

export interface HarnessAuthenticationBinding {
  readonly mode: HarnessAuthenticationMode;
  readonly reference: string;
}

export interface HarnessCapabilityProfile {
  readonly authenticationModes: ReadonlyArray<HarnessAuthenticationMode>;
  readonly session: {
    readonly affinity: "runtime-host" | "sandbox-lineage" | "portable";
    readonly fork: boolean;
    readonly humanAttach: HarnessHumanAttach;
  };
  readonly structuredOutput: "native" | "prompt-and-parse" | "none";
  readonly policyFidelity: "exact" | "profile-only" | "none";
  readonly fileEventFidelity: "terminal-only" | "best-effort" | "absent";
  readonly usageQuality: "metered" | "estimated" | "none";
  readonly readinessDiagnostics: boolean;
  readonly journal: boolean;
  readonly takeover: boolean;
}

export interface HarnessReadiness {
  readonly operational: {
    readonly status: "ready" | "unavailable" | "unknown";
    readonly retryable: boolean;
    readonly diagnostic: string;
  };
  readonly installation: {
    readonly status: "installed" | "missing" | "unknown";
    readonly version: string | null;
  };
  readonly compatibility: {
    readonly status: "compatible" | "incompatible" | "unknown";
    readonly requirement: string | null;
  };
  readonly authentication: {
    readonly mode: HarnessAuthenticationMode;
    readonly status: "available" | "unavailable" | "unknown";
    readonly diagnostic: string;
  };
  readonly diagnostics: ReadonlyArray<string>;
}

export interface HarnessSelection {
  readonly name: HarnessName;
  readonly model: string | null;
  readonly effort: string | null;
  readonly modelOptions: ReadonlyArray<OperationModelOption>;
  readonly profile: OperationPolicyProfile;
}

export type HarnessPreflightInput = Data.TaggedEnum<{
  Static: { readonly selection: HarnessSelection };
  Launch: { readonly request: HarnessRequest };
}>;

export const HarnessPreflightInput = Data.taggedEnum<HarnessPreflightInput>();

export const staticCatalogSource = (
  options: HarnessCatalogOptions,
  provenance: HarnessCatalogProvenance,
) => ({ catalog: Effect.succeed({ ...options, provenance }) });

export const selectionOfPreflightInput = HarnessPreflightInput.$match({
  Static: ({ selection }) => selection,
  Launch: ({ request }) => request.plan.harness,
});

export const fullHarnessExecution: HarnessExecution = {
  nonInteractive: true,
  worktreeConfined: true,
  profiles: ["read-only", "full"],
};

export type HarnessRunnerEnv =
  | SessionStore
  | ContextAssembler
  | CredentialStore
  | FileSystem.FileSystem
  | Path.Path
  | HttpClient.HttpClient;

export class HarnessError extends Schema.TaggedError<HarnessError>()("HarnessError", {
  reason: Schema.Literals([
    "unknown-harness",
    "missing-harness",
    "incompatible-harness",
    "credential",
    "stale-selection",
    "policy",
    "workspace",
    "sandbox",
    "launch",
    "turn",
  ]),
  retryable: Schema.Boolean,
  message: Schema.String,
}) {}

export const validateCheckoutDirectory = Effect.fn("Harness.validateCheckoutDirectory")(function* (
  harness: HarnessName,
  checkoutPath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const info = yield* fs.stat(checkoutPath).pipe(
    Effect.mapError(
      () =>
        new HarnessError({
          reason: "workspace",
          retryable: false,
          message: `harness runner ${harness} cannot access checkout directory ${checkoutPath}`,
        }),
    ),
  );
  if (info.type !== "Directory") {
    return yield* new HarnessError({
      reason: "workspace",
      retryable: false,
      message: `harness runner ${harness} checkout path is not a directory: ${checkoutPath}`,
    });
  }
  yield* fs.access(checkoutPath, { readable: true }).pipe(
    Effect.mapError(
      () =>
        new HarnessError({
          reason: "workspace",
          retryable: false,
          message: `harness runner ${harness} cannot read checkout directory ${checkoutPath}`,
        }),
    ),
  );
});

export interface HarnessRunner {
  readonly name: HarnessName;
  readonly sessionKind: SessionKind;
  /** Absent when the Harness has no such command: Cursor verifies its login during the launch. */
  readonly signIn?: string;
  readonly execution: HarnessExecution;
  readonly capabilities: HarnessCapabilityProfile;
  readonly authentication: HarnessAuthenticationBinding;
  readonly catalogSources: HarnessCatalogSources;
  readonly projectedMembers: ReadonlyArray<RunPlanMember>;
  readonly planMiddleware: ReadonlyArray<RunPlanMiddlewareName>;
  readonly readiness: () => Effect.Effect<HarnessReadiness, never, HarnessRunnerEnv>;
  readonly preflight: (input: HarnessPreflightInput) => Effect.Effect<void, HarnessError, HarnessRunnerEnv>;
  readonly run: (request: HarnessRequest) => Stream.Stream<AgUiEvent, HarnessError, HarnessRunnerEnv>;
}

export interface HarnessService {
  /** In registration order. */
  readonly names: ReadonlyArray<HarnessName>;
  readonly signIn: (harness: HarnessName) => string | null;
  readonly catalog: (
    harness: HarnessName,
  ) => Effect.Effect<HarnessOptionCatalog, HarnessError, HarnessRunnerEnv>;
  readonly preflight: (
    harness: HarnessName,
    profile: OperationPolicyProfile,
    model: string | null,
    effort?: string | null,
    modelOptions?: ReadonlyArray<OperationModelOption>,
  ) => Effect.Effect<void, HarnessError, HarnessRunnerEnv>;
  readonly run: (request: HarnessRequest) => Stream.Stream<AgUiEvent, HarnessError, HarnessRunnerEnv>;
  readonly sessionKind: (harness: HarnessName) => SessionKind;
  readonly capabilities: (harness: HarnessName) => HarnessCapabilityProfile | null;
  readonly readiness: (
    harness: HarnessName,
  ) => Effect.Effect<HarnessReadiness, HarnessError, HarnessRunnerEnv>;
  readonly projectedMembers: (harness: HarnessName) => ReadonlyArray<RunPlanMember>;
  readonly planMiddleware: (harness: HarnessName) => ReadonlyArray<RunPlanMiddlewareName>;
}

/** @effect-expect-leaking ContextAssembler | CredentialStore | FileSystem | HttpClient | Path | SessionStore */
export class Harness extends Context.Service<Harness, HarnessService>()("@cogwork/engine/harness") {}

const unknownHarness = (harness: HarnessName) =>
  new HarnessError({
    reason: "unknown-harness",
    retryable: false,
    message: `no harness runner registered for ${harness}`,
  });

const unavailableCatalog = (harness: HarnessName) =>
  new HarnessError({
    reason: "missing-harness",
    retryable: false,
    message: `no option catalog is available for harness runner ${harness}`,
  });

const hasCatalogOptions = (options: HarnessCatalogOptions | null): options is HarnessCatalogOptions =>
  options !== null && options.models.length > 0;

const catalogFrom = Effect.fn("Harness.catalogFrom")(function* (source: HarnessCatalogSource | undefined) {
  if (!source) return null;
  return yield* Effect.map(source.catalog, (catalog) => (hasCatalogOptions(catalog) ? catalog : null));
});

const resolveCatalog = Effect.fn("Harness.resolveCatalog")(function* (runner: HarnessRunner) {
  const runtimeCatalog = yield* catalogFrom(runner.catalogSources.runtime);
  if (runtimeCatalog) return runtimeCatalog;
  const nativeCatalog = yield* catalogFrom(runner.catalogSources.native);
  if (nativeCatalog) return nativeCatalog;
  const fallbackCatalog = yield* catalogFrom(runner.catalogSources.fallback);
  if (fallbackCatalog) return fallbackCatalog;
  return yield* unavailableCatalog(runner.name);
});

const unsupportedPosture = (runner: HarnessRunner, profile: OperationPolicyProfile) => {
  if (!runner.execution.nonInteractive) return "a non-interactive turn";
  if (!runner.execution.worktreeConfined) return "worktree confinement";
  if (!runner.execution.profiles.includes(profile)) return `${profile} operation posture`;
  return null;
};

const unsupportedRunnerPosture = (runner: HarnessRunner, profile: OperationPolicyProfile, posture: string) =>
  new HarnessError({
    reason: "policy",
    retryable: false,
    message: `harness runner ${runner.name} cannot enforce ${posture} for the ${profile} profile`,
  });

const staleSelection = (runner: HarnessRunner, option: string, value: string) =>
  new HarnessError({
    reason: "stale-selection",
    retryable: false,
    message: `harness runner ${runner.name} no longer offers ${option} ${value} on this Runtime Host`,
  });

const catalogHas = (choices: ReadonlyArray<{ readonly value: string }> | undefined, value: string) =>
  choices?.some((choice) => choice.value === value) ?? false;

const validateSelectionValue = (
  runner: HarnessRunner,
  option: string,
  choices: ReadonlyArray<{ readonly value: string }> | undefined,
  value: string | null,
) => {
  if (!value || catalogHas(choices, value)) return Effect.void;
  return Effect.fail(staleSelection(runner, option, value));
};

const declaredOptions = (catalog: HarnessCatalogSourceResult, model: string | null) =>
  catalog.models.find((candidate) => candidate.value === model)?.options ?? [];

const effortChoices = (catalog: HarnessCatalogSourceResult, model: string | null) =>
  declaredOptions(catalog, model).find((option) => option.id === effortOptionId)?.choices ?? catalog.efforts;

const modelOptionChoices = (options: ReadonlyArray<HarnessModelOption>, option: string) =>
  option === effortOptionId ? undefined : options.find((declared) => declared.id === option)?.choices;

interface SelectionCheck {
  readonly option: string;
  readonly choices: ReadonlyArray<{ readonly value: string }> | undefined;
  readonly value: string | null;
}

const validateSelection = (
  runner: HarnessRunner,
  catalog: HarnessCatalogSourceResult,
  selection: HarnessSelection,
) => {
  const declared = declaredOptions(catalog, selection.model);
  const checks: ReadonlyArray<SelectionCheck> = [
    { option: "model", choices: catalog.models, value: selection.model },
    { option: "effort", choices: effortChoices(catalog, selection.model), value: selection.effort },
    ...selection.modelOptions.map(({ option, value }) => ({
      option,
      choices: modelOptionChoices(declared, option),
      value,
    })),
  ];
  return Effect.forEach(
    checks,
    (check) => validateSelectionValue(runner, check.option, check.choices, check.value),
    { discard: true },
  );
};

const validateAuthenticationMode = (runner: HarnessRunner) => {
  if (!runner.capabilities.authenticationModes.includes(runner.authentication.mode)) {
    return Effect.fail(
      new HarnessError({
        reason: "credential",
        retryable: false,
        message: `harness runner ${runner.name} does not support the selected ${runner.authentication.mode} authentication binding`,
      }),
    );
  }
  return Effect.void;
};

const readinessFailure = (runner: HarnessRunner, readiness: HarnessReadiness) => {
  if (readiness.installation.status === "missing") {
    return new HarnessError({
      reason: "missing-harness",
      retryable: false,
      message: readiness.diagnostics[0] ?? `${runner.name} is not installed on this Runtime Host`,
    });
  }
  if (readiness.compatibility.status === "incompatible") {
    return new HarnessError({
      reason: "incompatible-harness",
      retryable: false,
      message: readiness.diagnostics[0] ?? `${runner.name} is incompatible with this Cogwork version`,
    });
  }
  if (readiness.authentication.mode !== runner.authentication.mode) {
    return new HarnessError({
      reason: "credential",
      retryable: false,
      message: `harness runner ${runner.name} did not report readiness for its selected ${runner.authentication.mode} authentication binding`,
    });
  }
  if (readiness.authentication.status === "unavailable") {
    return new HarnessError({
      reason: "credential",
      retryable: false,
      message: readiness.authentication.diagnostic,
    });
  }
  if (readiness.operational.status !== "unavailable") return null;
  return new HarnessError({
    reason: "launch",
    retryable: readiness.operational.retryable,
    message: readiness.operational.diagnostic,
  });
};

const validateReadiness = (runner: HarnessRunner, readiness: HarnessReadiness) => {
  const failure = readinessFailure(runner, readiness);
  return failure ? Effect.fail(failure) : Effect.void;
};

const runnerFor = Effect.fn("Harness.runnerFor")(function* (
  registry: ReadonlyMap<HarnessName, HarnessRunner>,
  harness: HarnessName,
) {
  const runner = registry.get(harness);
  if (!runner) return yield* unknownHarness(harness);
  return runner;
});

const preflightRunner = Effect.fn("Harness.preflightRunner")(function* (
  registry: ReadonlyMap<HarnessName, HarnessRunner>,
  input: HarnessPreflightInput,
) {
  const selection = selectionOfPreflightInput(input);
  const runner = yield* runnerFor(registry, selection.name);
  const catalog = yield* resolveCatalog(runner);
  yield* validateSelection(runner, catalog, selection);
  const posture = unsupportedPosture(runner, selection.profile);
  if (posture) return yield* unsupportedRunnerPosture(runner, selection.profile, posture);
  yield* validateAuthenticationMode(runner);
  yield* validateReadiness(runner, yield* runner.readiness());
  yield* runner.preflight(input);
  return runner;
});

const harnessOutcome = (exit: Exit.Exit<unknown, HarnessError>) => {
  if (Exit.isSuccess(exit)) return "success";
  if (Cause.hasInterruptsOnly(exit.cause)) return "interrupt";
  return "failure";
};

const dispatch = (runner: HarnessRunner, request: HarnessRequest) =>
  Stream.unwrap(
    Effect.andThen(
      Effect.logInfo("launched Harness", { harness: runner.name }),
      Effect.sync(() => runner.run(request)),
    ),
  ).pipe(
    Stream.onExit((exit) =>
      Effect.logInfo("exited Harness", { harness: runner.name, outcome: harnessOutcome(exit) }),
    ),
  );

export const make = (runners: ReadonlyArray<HarnessRunner>): HarnessService => {
  const registry = new Map(runners.map((runner) => [runner.name, runner] as const));
  const preflight = Effect.fn("Harness.preflight")(function* (
    harness: HarnessName,
    profile: OperationPolicyProfile,
    model: string | null,
    effort: string | null = null,
    modelOptions: ReadonlyArray<OperationModelOption> = [],
  ) {
    yield* preflightRunner(
      registry,
      HarnessPreflightInput.Static({
        selection: { name: harness, profile, model, effort, modelOptions },
      }),
    );
  });
  const catalog = Effect.fn("Harness.catalog")(function* (harness: HarnessName) {
    const runner = yield* runnerFor(registry, harness);
    const resolved = yield* resolveCatalog(runner);
    return {
      ...resolved,
      policyProfiles: runner.execution.profiles,
    };
  });
  const readiness = Effect.fn("Harness.readiness")(function* (harness: HarnessName) {
    return yield* (yield* runnerFor(registry, harness)).readiness();
  });
  return {
    names: runners.map((runner) => runner.name),
    signIn: (harness) => registry.get(harness)?.signIn ?? null,
    catalog,
    preflight,
    run: (request) =>
      Stream.fromEffect(preflightRunner(registry, HarnessPreflightInput.Launch({ request }))).pipe(
        Stream.flatMap((runner) => dispatch(runner, request)),
        Stream.withSpan("Harness.run"),
      ),
    sessionKind: (harness) => registry.get(harness)?.sessionKind ?? "opaque-handle",
    capabilities: (harness) => registry.get(harness)?.capabilities ?? null,
    readiness,
    projectedMembers: (harness) => registry.get(harness)?.projectedMembers ?? [],
    planMiddleware: (harness) => registry.get(harness)?.planMiddleware ?? [],
  };
};

export const layer = (runners: ReadonlyArray<HarnessRunner>) => Layer.succeed(Harness, make(runners));
