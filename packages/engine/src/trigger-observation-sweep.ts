import { keyOf, type WorkflowDocument } from "@cogwork/contracts";
import * as Effect from "effect/Effect";
import { sweepKey } from "./clock-source";
import { Coordination } from "./coordination";
import { IssueTracker } from "./issue-tracker";
import { providerSubject } from "./provider-trigger-source";
import { WorkspaceRegistry } from "./registry-service";
import type { TriggerAdmission } from "./trigger-observation-admission";
import { TriggerObservationStore } from "./trigger-observation-store";
import {
  SourceFailure,
  type SweepCandidate,
  type TriggerReadPort,
  type TriggerSubscription,
} from "./trigger-source";
import { Workflows } from "./workflow";

const trackerSystems = ["github", "linear"] as const;

const trackerSystemsOf = (document: WorkflowDocument | null) =>
  new Set(
    document?.operations.flatMap(({ transitions }) =>
      transitions.flatMap(({ actions }) =>
        actions.flatMap(({ entry }) => trackerSystems.filter((system) => entry.startsWith(`${system}.`))),
      ),
    ) ?? [],
  );

const subscriptionParameter = (subscription: TriggerSubscription, id: string) =>
  subscription.parameters.find((parameter) => parameter.id === id)?.value;

const sweepFailure = (error: unknown) =>
  new SourceFailure({
    source: "clock",
    reason: "unavailable",
    retryAfterMillis: null,
    message: error instanceof Error ? error.message : String(error),
  });

export const makeSweepReadPort = Effect.gen(function* () {
  const workflows = yield* Workflows;
  const coordination = yield* Coordination;
  const store = yield* TriggerObservationStore;
  const tracker = yield* IssueTracker;
  const registry = yield* WorkspaceRegistry;

  const lastSweepTimes = Effect.fn("TriggerObservation.lastSweepTimes")(function* (
    subscription: TriggerSubscription,
  ) {
    const admissions = yield* Effect.all([store.admissions, store.processed]).pipe(
      Effect.map((all) => all.flat()),
    );
    return admissions
      .filter(
        (admission) =>
          admission.event.entry === sweepKey &&
          admission.subscription.workflow === subscription.workflow &&
          admission.subscription.trigger === subscription.trigger,
      )
      .reduce((times, admission) => {
        const item = keyOf(admission.event.key);
        return new Map(times).set(item, Math.max(times.get(item) ?? 0, admission.event.atMillis));
      }, new Map<string, number>());
  });

  const trackerSweepCandidates = Effect.fn("TriggerObservation.trackerSweepCandidates")(function* (
    subscription: TriggerSubscription,
    tickInstant: number,
    state: string,
    sweptAt: ReadonlyMap<string, number>,
  ) {
    const registryState = yield* registry.state;
    const listedWorkflows = yield* workflows.list;
    const document =
      listedWorkflows.workflows.find(({ id }) => id === subscription.workflow)?.publishedCopy ?? null;
    const systems = trackerSystemsOf(document);
    const workspaces = registryState.workspaces.filter(({ config }) => {
      const isSelected = subscription.workspaces.includes(config.id);
      const matchesSystem =
        systems.size === 0 ||
        trackerSystems.some((system) => systems.has(system) && config.issueTracker.type === system);
      return isSelected && matchesSystem;
    });
    const listed = yield* Effect.forEach(workspaces, (workspace) =>
      tracker.observe(workspace).pipe(
        Effect.flatMap((items) =>
          Effect.forEach(items, (item) => {
            const key = { _tag: "Issue", workspace: workspace.config.id, id: item.id } as const;
            return coordination.read(key).pipe(Effect.map((view) => ({ item, key, view, workspace })));
          }),
        ),
      ),
    );
    return listed.flat().flatMap(({ item, key, view, workspace }): ReadonlyArray<SweepCandidate> => {
      const matchesState = state === "parked" ? view.park !== null : (item.states ?? []).includes(state);
      if (!matchesState) return [];
      const lastTouchedAtMillis = Math.max(
        item.lastTouchedAtMillis ?? tickInstant,
        view.park?.atMillis ?? 0,
        sweptAt.get(keyOf(key)) ?? 0,
      );
      return [
        {
          key,
          workspace: workspace.config.id,
          subject: providerSubject(item.title, item.url),
          lastTouchedAtMillis,
          loadWorkContext: tracker.readProse(workspace, item.id).pipe(Effect.mapError(sweepFailure)),
        },
      ];
    });
  });

  const workflowSweepCandidates = Effect.fn("TriggerObservation.workflowSweepCandidates")(function* (
    subscription: TriggerSubscription,
    state: string,
    sweptAt: ReadonlyMap<string, number>,
  ) {
    const admissions = yield* Effect.all([store.admissions, store.processed]).pipe(
      Effect.map((all) => all.flat()),
    );
    const latest = admissions
      .filter(
        (admission) =>
          admission.subscription.workflow === subscription.workflow &&
          admission.event.entry !== sweepKey &&
          admission.event.key._tag !== "Issue",
      )
      .reduce((items, admission) => {
        const item = keyOf(admission.event.key);
        const current = items.get(item);
        return current === undefined || current.event.atMillis < admission.event.atMillis
          ? new Map(items).set(item, admission)
          : items;
      }, new Map<string, TriggerAdmission>());
    return yield* Effect.forEach([...latest.values()], (admission) =>
      coordination.read(admission.event.key).pipe(
        Effect.map((view): SweepCandidate | null => {
          const matchesState = state === "parked" && view.park !== null;
          if (!matchesState) return null;
          return {
            key: admission.event.key,
            workspace: admission.event.workspace,
            subject: admission.event.subject,
            lastTouchedAtMillis: Math.max(
              admission.event.atMillis,
              view.park?.atMillis ?? 0,
              sweptAt.get(keyOf(admission.event.key)) ?? 0,
            ),
            loadWorkContext: Effect.succeed(admission.event.workContext),
          };
        }),
      ),
    ).pipe(Effect.map((candidates) => candidates.filter((candidate) => candidate !== null)));
  });

  const sweep = Effect.fn("TriggerObservation.sweep")(function* (
    subscription: TriggerSubscription,
    tickInstant: number,
  ) {
    const source = subscriptionParameter(subscription, "source");
    const state = subscriptionParameter(subscription, "state");
    if (state === undefined) return yield* sweepFailure("Sweep state is missing");
    const sweptAt = yield* lastSweepTimes(subscription);
    const reader = [
      {
        source: "trackers",
        read: () => trackerSweepCandidates(subscription, tickInstant, state, sweptAt),
      },
      {
        source: "workflow",
        read: () => workflowSweepCandidates(subscription, state, sweptAt),
      },
    ].find((candidate) => candidate.source === source);
    if (reader === undefined) return yield* sweepFailure("Sweep source is invalid");
    return yield* reader.read();
  });
  const sweepReadPort: TriggerReadPort = {
    sweep: (subscription, tickInstant) =>
      sweep(subscription, tickInstant).pipe(Effect.mapError(sweepFailure)),
  };
  return sweepReadPort;
});
