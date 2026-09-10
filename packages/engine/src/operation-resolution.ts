import type {
  AvailabilityCause,
  ControlStore as ControlStorePicture,
  FileContribution,
  HarnessName,
  LifecycleStage,
  PluginContribution,
  PluginMcpServer,
  PluginOverview,
  RunId,
  RunPlan,
  RunPlanObservation,
  Session,
  SessionId,
} from "@cogwork/contracts";
import {
  harnessEnabled,
  LifecycleStage as LifecycleStageSchema,
  OperationAvailability,
  PluginContributionLoad,
} from "@cogwork/contracts";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { Availability } from "./availability";
import type { EligibleWork } from "./classify";
import { ConnectionStore } from "./connection";
import { ContextAssembler } from "./context-assembler";
import { ControlStore } from "./control-store";
import { CredentialStore } from "./credential-store";
import { Harness, type HarnessCapabilityProfile, type HarnessRunnerEnv } from "./harness";
import { McpSkillAssembler, type ResolvedMcpSkill } from "./mcp-skill";
import { buildFollowUpPrompt, buildImplementPrompt, buildTriagePrompt } from "./playbook";
import { PluginManager } from "./plugin";
import type { RegisteredWorkspace } from "./projector";
import {
  type AvailabilityContribution,
  applicableContributionSettings,
  availabilityCauses,
  buildRunPlan,
  operationBindingsOf,
  type ResolvedOperation,
  resolveEngineContributionEnabled,
  resolveRunPlanStage,
  runPlanAssemblyError,
} from "./run-plan";
import { decideSessionChoice, type SessionChoice, type SessionChoiceInputs } from "./session-choice";
import { SessionStore } from "./session-store";

interface PluginMcpContribution {
  readonly id: string;
  readonly server: PluginMcpServer;
}

interface AvailabilityFacts {
  readonly checkoutCause: AvailabilityCause | null;
  readonly connectionContributions: ReadonlyArray<AvailabilityContribution>;
  readonly harnessCauses: ReadonlyMap<string, AvailabilityCause | null>;
  readonly liveReasons: ReadonlyMap<string, string | null>;
  readonly pluginContributions: ReadonlyArray<PluginContribution>;
  readonly pluginMcpServers: ReadonlyArray<
    ResolvedMcpSkill & { readonly identity: string; readonly unavailableReason: string | null }
  >;
}

export type CandidateSessionFacts = Omit<
  SessionChoiceInputs,
  "selectedHarness" | "sessionAffinity" | "maxAgeMillis" | "maxTokens" | "now"
>;

export interface CandidateFacts {
  readonly runId: RunId;
  readonly workspace: RegisteredWorkspace;
  readonly item: EligibleWork;
  readonly observation: RunPlanObservation;
  readonly checkoutPath: string;
  readonly continuationPrompt: string;
  readonly startedAtMillis: number;
  readonly sessionChoice: CandidateSessionFacts;
}

export interface AcceptedOperation {
  readonly plan: RunPlan;
  readonly mcpCredentials: ReadonlyMap<string, Redacted.Redacted<string>>;
  readonly session: SessionId;
  readonly resolved: ResolvedOperation;
  readonly sessionChoice: SessionChoice;
}

export class OperationUnavailable extends Schema.TaggedError<OperationUnavailable>()("OperationUnavailable", {
  availability: OperationAvailability,
}) {}

const noPlugins = { plugins: [] } satisfies PluginOverview;

const pluginMcp = (contribution: PluginContribution) =>
  PluginContributionLoad.match(contribution.load, {
    Failed: () => [],
    Loaded: ({ mcpServer }) =>
      mcpServer
        ? ([{ id: contribution.id, server: mcpServer }] satisfies ReadonlyArray<PluginMcpContribution>)
        : [],
  });

const installedContributions = (overview: PluginOverview) =>
  overview.plugins.filter(({ record }) => record !== null).flatMap(({ contributions }) => contributions);

const unavailableContribution = (
  contribution: PluginContribution,
): ReadonlyArray<readonly [string, string]> => {
  if (PluginContributionLoad.guards.Loaded(contribution.load)) return [];
  return [[contribution.id, contribution.load.reason]];
};

const pluginFileContribution = (contribution: PluginContribution) => ({
  id: contribution.id,
  authority: contribution.authority,
  kind: contribution.kind,
  localName: contribution.localName,
  file: contribution.file,
});

const enabledContribution = (
  resolved: ResolvedOperation,
  workspace: RegisteredWorkspace,
  contribution: FileContribution,
) =>
  contribution.kind !== "mcp-server" ||
  resolveEngineContributionEnabled(
    applicableContributionSettings(resolved.contributionSettings, contribution, workspace.config.name),
    contribution.authority,
  ).value;

const localAvailability = (
  resolved: ResolvedOperation,
  workspace: RegisteredWorkspace,
  contribution: FileContribution,
) =>
  ({
    id: contribution.id,
    kind: contribution.kind,
    enabled: enabledContribution(resolved, workspace, contribution),
    ready: true,
    reason: null,
  }) satisfies AvailabilityContribution;

const pluginReadiness = (contribution: PluginContribution, liveReasons: ReadonlyMap<string, string | null>) =>
  PluginContributionLoad.match(contribution.load, {
    Failed: ({ reason }) => reason,
    Loaded: ({ mcpServer }) => {
      if (contribution.kind !== "mcp-server") return null;
      if (!mcpServer) return "MCP server definition is unavailable";
      if (liveReasons.has(contribution.id)) return liveReasons.get(contribution.id) ?? null;
      return mcpServer.credentialAvailable ? null : "MCP server credential is unavailable";
    },
  });

const pluginAvailability = (
  resolved: ResolvedOperation,
  workspace: RegisteredWorkspace,
  contribution: PluginContribution,
  liveReasons: ReadonlyMap<string, string | null>,
) => {
  const reason = pluginReadiness(contribution, liveReasons);
  return {
    id: contribution.id,
    kind: contribution.kind,
    enabled: enabledContribution(resolved, workspace, pluginFileContribution(contribution)),
    ready: reason === null,
    reason,
  } satisfies AvailabilityContribution;
};

const policyRefusal = (source: string, message: string) =>
  ({ _tag: "PolicyRefusal", source, message }) satisfies AvailabilityCause;

const hostFailure = (
  fact: Extract<AvailabilityCause, { readonly _tag: "RuntimeHostFactFailed" }>["fact"],
  message: string,
) => ({ _tag: "RuntimeHostFactFailed", fact, message }) satisfies AvailabilityCause;

const disabledHarnessCause = (harnessName: HarnessName) =>
  hostFailure("harness", `${harnessName} Harness is disabled on this Runtime host`);

const unavailableHarnessCause = (message: string) =>
  hostFailure("harness", `Harness enablement is unavailable: ${message}`);

const currentHarnessDisablement = (picture: ControlStorePicture, harnessName: HarnessName) => {
  if (harnessEnabled(picture.harnessSettings, harnessName)) return null;
  return disabledHarnessCause(harnessName);
};

const selectedHarnessDisablement = (picture: ControlStorePicture, harnessName: HarnessName | null) =>
  harnessName ? currentHarnessDisablement(picture, harnessName) : null;

const harnessProbeKey = (resolved: ResolvedOperation) =>
  JSON.stringify([resolved.stage.harness, resolved.profile, resolved.stage.model, resolved.stage.effort]);

const sessionAffinity = (
  session: Session | null,
  capabilities: (harness: HarnessName) => HarnessCapabilityProfile | null,
) => (session ? (capabilities(session.harness)?.session.affinity ?? null) : null);

const promptFor = (workspace: RegisteredWorkspace, item: EligibleWork, resolved: ResolvedOperation) => {
  if (item.stage === "implement") return buildImplementPrompt(resolved.stage, item);
  if (item.stage === "follow-up") {
    return buildFollowUpPrompt(resolved.stage, item, workspace.config.linearHistory);
  }
  return buildTriagePrompt(resolved.stage, item);
};

const selectedPrompt = (
  choice: ReturnType<typeof decideSessionChoice>,
  full: string,
  continuation: string,
) => {
  if (choice.prompt === "continuation") return continuation;
  if (choice.prompt === "combined") return `${full}\n\n${continuation}`;
  return full;
};

export const make = Effect.gen(function* () {
  const availability = yield* Availability;
  const assembler = yield* McpSkillAssembler;
  const connections = yield* ConnectionStore;
  const contextAssembler = yield* ContextAssembler;
  const controlStore = yield* ControlStore;
  const fs = yield* FileSystem.FileSystem;
  const harness = yield* Harness;
  const plugins = yield* PluginManager;
  const sessionStore = yield* SessionStore;
  const harnessRunnerContext = yield* Effect.context<HarnessRunnerEnv>().pipe(
    Effect.map(
      Context.pick(
        SessionStore,
        ContextAssembler,
        CredentialStore,
        FileSystem.FileSystem,
        Path.Path,
        HttpClient.HttpClient,
      ),
    ),
  );

  const selectedHarnessCause = (harnessName: HarnessName | null) => {
    if (controlStore.health === "unavailable") {
      return Effect.succeed(unavailableHarnessCause(controlStore.message));
    }
    return controlStore.picture.pipe(
      Effect.match({
        onFailure: (error) => unavailableHarnessCause(error.message),
        onSuccess: (picture) => selectedHarnessDisablement(picture, harnessName),
      }),
    );
  };

  const loadPluginOverview = Effect.fn("OperationResolution.loadPluginOverview")(function* () {
    return yield* plugins.overview.pipe(
      Effect.catchTag("PluginFailure", (error) =>
        Effect.logWarning("Plugin snapshot unavailable", { message: error.message }).pipe(
          Effect.map(() => noPlugins),
        ),
      ),
    );
  });

  const preparePluginMcpServer = Effect.fn("OperationResolution.preparePluginMcpServer")(function* ({
    id,
    server,
  }: PluginMcpContribution) {
    const { endpoint, secretEnv } = server;
    const unavailable = (message: string) => ({
      identity: id,
      name: id,
      endpoint,
      bearer: null,
      unavailableReason: message,
    });
    if (!server.credentialAvailable) {
      return unavailable(
        secretEnv ? `MCP server needs environment key ${secretEnv}` : `${id} needs a ready Connection`,
      );
    }
    if (server.connectionId) {
      return yield* connections.bearer(server.connectionId).pipe(
        Effect.match({
          onFailure: (error) => unavailable(error.message),
          onSuccess: (credential) => ({
            identity: id,
            name: id,
            endpoint,
            bearer: credential.token,
            unavailableReason: null,
          }),
        }),
      );
    }
    if (!secretEnv) {
      return { identity: id, name: id, endpoint, bearer: null, unavailableReason: null };
    }
    return yield* Config.redacted(secretEnv).pipe(
      Effect.match({
        onFailure: (error) => unavailable(`MCP server needs environment key ${secretEnv}: ${error.message}`),
        onSuccess: (bearer) => ({
          identity: id,
          name: id,
          endpoint,
          bearer,
          unavailableReason: null,
        }),
      }),
    );
  });

  const prepareResolution = (workspace: RegisteredWorkspace, overview: PluginOverview) => {
    const installed = overview.plugins.filter(({ record }) => record !== null);
    const pluginContributions = installed.flatMap(({ contributions }) => contributions);
    const loaded = pluginContributions.filter(({ load }) => PluginContributionLoad.guards.Loaded(load));
    const loadedIdentities = new Set(loaded.map(({ id }) => id));
    const pluginFiles = pluginContributions.map(pluginFileContribution);
    return {
      planContributions: [...workspace.contributions, ...pluginFiles],
      contextContributionIds: new Set([...workspace.contributions.map(({ id }) => id), ...loadedIdentities]),
      provenanceStamps: installed.flatMap(({ provenanceStamp }) =>
        provenanceStamp ? [provenanceStamp] : [],
      ),
      unavailableContributionReasons: new Map(pluginContributions.flatMap(unavailableContribution)),
    };
  };

  const resolveStage = Effect.fn("OperationResolution.resolveStage")(function* (
    workspace: RegisteredWorkspace,
    operation: LifecycleStage,
  ) {
    const picture = controlStore.health === "available" ? yield* controlStore.picture : null;
    return resolveRunPlanStage(
      workspace.config,
      operation,
      picture?.operationSettings ?? [],
      picture?.contributionSettings ?? [],
    );
  });

  const checkoutAvailability = Effect.fn("OperationResolution.checkoutAvailability")(function* (
    workspace: RegisteredWorkspace,
  ) {
    return yield* fs.exists(workspace.config.checkoutPath).pipe(
      Effect.match({
        onFailure: () => hostFailure("checkout-path", "workspace checkout path is unreadable"),
        onSuccess: (exists) =>
          exists ? null : hostFailure("checkout-path", "workspace checkout path does not exist"),
      }),
    );
  });

  const readHarnessAvailability = Effect.fn("OperationResolution.readHarnessAvailability")(function* (
    resolved: ResolvedOperation,
  ) {
    const picture = yield* controlStore.picture;
    const disablement = currentHarnessDisablement(picture, resolved.stage.harness);
    if (disablement) return disablement;
    return yield* harness
      .preflight(resolved.stage.harness, resolved.profile, resolved.stage.model, resolved.stage.effort)
      .pipe(
        Effect.provide(harnessRunnerContext),
        Effect.match({
          onFailure: (error) => {
            if (error.retryable) return null;
            if (error.reason === "credential") return hostFailure("credential", error.message);
            if (error.reason === "policy") {
              return policyRefusal(`Harness ${resolved.stage.harness}`, error.message);
            }
            return hostFailure("harness", error.message);
          },
          onSuccess: () => null,
        }),
      );
  });

  const harnessAvailability = Effect.fn("OperationResolution.harnessAvailability")(
    (resolved: ResolvedOperation) =>
      readHarnessAvailability(resolved).pipe(
        Effect.catchTag("ControlStoreFailure", (error) =>
          Effect.succeed(unavailableHarnessCause(error.message)),
        ),
      ),
  );

  const connectionAvailability = Effect.fn("OperationResolution.connectionAvailability")(function* () {
    return yield* connections.overview.pipe(
      Effect.match({
        onFailure: () => [] satisfies ReadonlyArray<AvailabilityContribution>,
        onSuccess: (overview) =>
          overview.connections.flatMap(({ connection, readiness }) => {
            if (!connection) return [];
            const reason = readiness._tag === "Ready" ? null : readiness.reason;
            return [
              {
                id: connection.id,
                kind: "connection",
                enabled: true,
                ready: reason === null,
                reason,
              } satisfies AvailabilityContribution,
            ];
          }),
      }),
    );
  });

  const loadAvailabilityFacts = Effect.fn("OperationResolution.loadAvailabilityFacts")(function* (
    workspace: RegisteredWorkspace,
    resolvedOperations: ReadonlyArray<ResolvedOperation>,
    overview: PluginOverview,
  ) {
    const pluginContributions = installedContributions(overview);
    const enabledMcpIds = new Set(
      pluginContributions.flatMap((contribution) =>
        resolvedOperations.some((resolved) =>
          enabledContribution(resolved, workspace, pluginFileContribution(contribution)),
        )
          ? [contribution.id]
          : [],
      ),
    );
    const pluginMcpServers = yield* Effect.forEach(
      pluginContributions.flatMap(pluginMcp).filter(({ id }) => enabledMcpIds.has(id)),
      preparePluginMcpServer,
    );
    const liveReasons = new Map(
      pluginMcpServers.map(
        ({ identity, unavailableReason }) =>
          [identity, unavailableReason] satisfies readonly [string, string | null],
      ),
    );
    const distinctHarnesses = Array.from(
      new Map(resolvedOperations.map((resolved) => [harnessProbeKey(resolved), resolved])).values(),
    );
    const harnessCauses = new Map(
      yield* Effect.forEach(distinctHarnesses, (resolved) =>
        harnessAvailability(resolved).pipe(
          Effect.map(
            (cause) =>
              [harnessProbeKey(resolved), cause] satisfies readonly [string, AvailabilityCause | null],
          ),
        ),
      ),
    );
    const needsConnections = resolvedOperations.some((resolved) =>
      resolved.stage.needs.some(({ kind }) => kind === "connection"),
    );
    return {
      checkoutCause: yield* checkoutAvailability(workspace),
      connectionContributions: needsConnections ? yield* connectionAvailability() : [],
      harnessCauses,
      liveReasons,
      pluginContributions,
      pluginMcpServers,
    } satisfies AvailabilityFacts;
  });

  const evaluateResolvedAvailability = Effect.fn("OperationResolution.evaluateResolvedAvailability")(
    function* (
      workspace: RegisteredWorkspace,
      operation: LifecycleStage,
      resolved: ResolvedOperation | null,
      facts: AvailabilityFacts,
    ) {
      const conclude = (causes: ReadonlyArray<AvailabilityCause>) => {
        const conclusion: OperationAvailability = {
          operation,
          available: causes.length === 0,
          causes,
        };
        return availability.record(workspace, conclusion).pipe(Effect.map(() => conclusion));
      };
      if (!resolved) {
        return {
          resolved,
          availability: yield* conclude([
            policyRefusal("Engine Operation Definition", `${operation} is not supported`),
          ]),
        };
      }
      const contributions = [
        ...workspace.contributions.map((contribution) =>
          localAvailability(resolved, workspace, contribution),
        ),
        ...facts.pluginContributions.map((contribution) =>
          pluginAvailability(resolved, workspace, contribution, facts.liveReasons),
        ),
        ...(resolved.stage.needs.some(({ kind }) => kind === "connection")
          ? facts.connectionContributions
          : []),
      ];
      const runtimeCauses = [
        facts.checkoutCause,
        facts.harnessCauses.get(harnessProbeKey(resolved)) ?? null,
      ].filter((cause) => cause !== null);
      const causes = [
        ...(resolved.stage.enabled
          ? []
          : [policyRefusal(`${operation} Operation Definition`, `${operation} is disabled`)]),
        ...availabilityCauses({
          needs: resolved.stage.needs,
          bindings: operationBindingsOf(resolved),
          contributions,
          projectedMembers: harness.projectedMembers(resolved.stage.harness),
        }),
        ...runtimeCauses,
      ];
      return { resolved, availability: yield* conclude(causes) };
    },
  );

  const evaluateAvailability = Effect.fn("OperationResolution.evaluateAvailability")(function* (
    workspace: RegisteredWorkspace,
    operation: LifecycleStage,
  ) {
    const overview = yield* loadPluginOverview();
    const resolved = yield* controlStore.withWrite(resolveStage(workspace, operation));
    const facts = yield* loadAvailabilityFacts(workspace, resolved ? [resolved] : [], overview);
    return {
      ...(yield* evaluateResolvedAvailability(workspace, operation, resolved, facts)),
      facts,
      overview,
    };
  });

  const inspect = Effect.fn("OperationResolution.inspect")(
    (workspace: RegisteredWorkspace, operation: LifecycleStage) =>
      evaluateAvailability(workspace, operation).pipe(
        Effect.map(({ availability, resolved }) => ({ availability, resolved })),
      ),
  );

  const availabilityOf = Effect.fn("OperationResolution.availabilityOf")(
    (workspace: RegisteredWorkspace, item: EligibleWork) =>
      evaluateAvailability(workspace, item.stage).pipe(Effect.map(({ availability }) => availability)),
  );

  const currentHarnessCause = Effect.fn("OperationResolution.currentHarnessCause")(function* (
    workspace: RegisteredWorkspace,
    operation: LifecycleStage,
  ) {
    return yield* resolveStage(workspace, operation).pipe(
      Effect.matchEffect({
        onFailure: (error) => Effect.succeed(unavailableHarnessCause(error.message)),
        onSuccess: (resolved) => selectedHarnessCause(resolved?.stage.harness ?? null),
      }),
    );
  });

  const harnessCause = Effect.fn("OperationResolution.harnessCause")((harnessName: HarnessName) =>
    selectedHarnessCause(harnessName),
  );
  const refreshAvailability = Effect.fn("OperationResolution.refreshAvailability")(function* (
    workspace: RegisteredWorkspace,
  ) {
    const overview = yield* loadPluginOverview();
    const operations = yield* Effect.forEach(Array.from(LifecycleStageSchema.literals), (operation) =>
      controlStore
        .withWrite(resolveStage(workspace, operation))
        .pipe(Effect.map((resolved) => ({ operation, resolved }))),
    );
    const facts = yield* loadAvailabilityFacts(
      workspace,
      operations.flatMap(({ resolved }) => (resolved ? [resolved] : [])),
      overview,
    );
    return yield* Effect.forEach(operations, ({ operation, resolved }) =>
      evaluateResolvedAvailability(workspace, operation, resolved, facts).pipe(
        Effect.map(({ availability }) => availability),
      ),
    );
  });

  const resolve = Effect.fn("OperationResolution.resolve")(function* (facts: CandidateFacts) {
    const evaluated = yield* evaluateAvailability(facts.workspace, facts.item.stage);
    if (!evaluated.availability.available || !evaluated.resolved) {
      return yield* new OperationUnavailable({ availability: evaluated.availability });
    }
    const resolved = evaluated.resolved;
    const choice = decideSessionChoice({
      ...facts.sessionChoice,
      selectedHarness: resolved.stage.harness,
      sessionAffinity: sessionAffinity(facts.sessionChoice.session, harness.capabilities),
      maxAgeMillis: resolved.stage.resumeMaxAgeMillis,
      maxTokens: resolved.stage.resumeMaxTokens,
      now: yield* Clock.currentTimeMillis,
    });
    const fullPrompt = promptFor(facts.workspace, facts.item, resolved);
    const prompt = selectedPrompt(choice, fullPrompt, facts.continuationPrompt);
    const prepared = prepareResolution(facts.workspace, evaluated.overview);
    const builder = buildRunPlan({
      runId: facts.runId,
      workspace: facts.workspace,
      item: facts.item,
      observation: facts.observation,
      resolved,
      prompt,
      checkoutPath: facts.checkoutPath,
      sessionKind: harness.sessionKind(resolved.stage.harness),
      projectedMembers: harness.projectedMembers(resolved.stage.harness),
      middleware: harness.planMiddleware(resolved.stage.harness),
      contributions: prepared.planContributions,
      provenanceStamps: prepared.provenanceStamps,
      unavailableContributionReasons: prepared.unavailableContributionReasons,
    });
    const contributions = builder.contributions.filter(({ id }) => prepared.contextContributionIds.has(id));
    const context = yield* contextAssembler.assemble({
      runId: facts.runId,
      workspace: facts.workspace.config.name,
      cwd: facts.checkoutPath,
      projectRoot: facts.checkoutPath,
      operatingInstructions: resolved.stage.skill,
      contributions,
    });
    const admittedIdentities = new Set(builder.contributions.map(({ id }) => id));
    const pluginMcpServers = evaluated.facts.pluginMcpServers.filter(({ identity }) =>
      admittedIdentities.has(identity),
    );
    const workspaceMcpServers = (yield* assembler.assemble(facts.workspace.config)).map((server) => ({
      ...server,
      identity: null,
      unavailableReason: server.unavailableReason ?? null,
    }));
    const session =
      choice.session ??
      (yield* sessionStore.mint(
        {
          workspace: facts.workspace.config.name,
          harness: resolved.stage.harness,
          createdAtMillis: facts.startedAtMillis,
        },
        harness.sessionKind,
      ));
    const assembly = yield* Effect.try({
      try: () => builder.complete({ context, mcpServers: [...workspaceMcpServers, ...pluginMcpServers] }),
      catch: runPlanAssemblyError,
    });
    return { ...assembly, session, resolved, sessionChoice: choice } satisfies AcceptedOperation;
  });

  return {
    availabilityOf,
    inspect,
    refreshAvailability,
    resolve,
    currentHarnessCause,
    harnessCause,
  };
});

export type OperationResolutionService = Effect.Success<typeof make>;

export class OperationResolution extends Context.Service<OperationResolution, OperationResolutionService>()(
  "@cogwork/engine/operation-resolution/OperationResolution",
) {}

export const layer = Layer.effect(OperationResolution, make);
