import { WorkItemId, WorkspaceConfig, WorkspaceId } from "@cogwork/contracts";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { IssueTrackerError } from "../issue-tracker";
import {
  PerformanceIssueFiler,
  PerformanceIssueFingerprint,
  type PerformanceVerdict,
} from "../performance-issue-filer";
import type { RegisteredWorkspace } from "../projector";
import { readOnlyRegistry, WorkspaceRegistry } from "../registry";
import { GitHubClient, type GitHubClientService } from "./client";
import { makePerformanceIssueFilerTarget } from "./index";
import { wireCodec } from "./markers";
import { confirmPerformanceIssue, layer, performanceIssueHistory } from "./performance-issue-filer";

const marker = wireCodec.encode({
  name: "selfperf",
  pairs: "fingerprint=daemon.event-loop-delay-p99.above",
});
const decodeWorkItemId = Schema.decodeSync(WorkItemId);
const decodeWorkspaceId = Schema.decodeSync(WorkspaceId);
const performanceFingerprint = Schema.decodeSync(PerformanceIssueFingerprint)(
  "daemon.event-loop-delay-p99.above",
);
const performanceVerdict = {
  kind: "health-signal",
  signal: "event-loop-delay-p99",
  subsystem: "daemon",
  direction: "above",
  observed: 125,
  threshold: 100,
  unit: "ms",
  windowMillis: 10_000,
  consecutiveBreaches: 3,
  evidence: {
    path: "/tmp/daemon.event-loop-delay-p99.above.json",
    appVersion: "0.0.1-test",
    runsInFlight: 2,
    workspaceCount: 1,
    machineLoad: { cpuCount: 8, loadAverage: [1, 0.5, 0.25], freeMemoryBytes: 1_000 },
  },
} satisfies PerformanceVerdict;
const noPullReferences = () => Effect.succeed([]);
const pullReference = (body: string, merged = true) => ({
  body,
  merged,
  repository: "colonylabs/cogwork",
});

const issue = (
  number: number,
  body: string,
  state: "open" | "closed" = "open",
  authorLogin = "cogwork-bot",
) => ({
  nodeId: `I_issue_${number}`,
  number,
  title: `Issue ${number}`,
  url: `https://github.com/colonylabs/cogwork/issues/${number}`,
  labels: [],
  assignees: [],
  isPullRequest: false,
  openBlockers: 0,
  body,
  state,
  createdAtMillis: number,
  authorLogin,
});

class CreateIssueCalls extends Context.Service<CreateIssueCalls, Ref.Ref<number>>()(
  "@cogwork/engine/github/performance-issue-filer.test/CreateIssueCalls",
) {
  static readonly layer = Layer.effect(CreateIssueCalls, Ref.make(0));
}

const performanceWorkspaceName = decodeWorkspaceId("performance");
const performanceWorkspace: RegisteredWorkspace = {
  source: "control-store:performance",
  repository: "colonylabs/cogwork",
  contributions: [],
  config: Schema.decodeSync(WorkspaceConfig)({
    name: performanceWorkspaceName,
    checkoutPath: "/repos/cogwork",
    issueTracker: { type: "github" },
  }),
};
const linearPerformanceWorkspaceName = decodeWorkspaceId("linear-performance");
const linearPerformanceWorkspace: RegisteredWorkspace = {
  ...performanceWorkspace,
  repository: "colonylabs/cogwork",
  config: Schema.decodeSync(WorkspaceConfig)({
    name: linearPerformanceWorkspaceName,
    checkoutPath: "/repos/linear-performance",
    issueTracker: { type: "linear", teams: ["CGW"] },
  }),
};

const unexpectedClientCall = () => Effect.die("unexpected GitHub client call");
const filerLayer = (workspaceName: WorkspaceId | undefined, workspaces: ReadonlyArray<RegisteredWorkspace>) =>
  layer(workspaceName).pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(GitHubClient, {}),
        Layer.succeed(WorkspaceRegistry, readOnlyRegistry({ workspaces, failures: [] })),
      ),
    ),
  );

it.effect("decodes fingerprints once and keeps labeled markerless issues for cap accounting", () =>
  Effect.gen(function* () {
    const references = new Map([
      [1, [pullReference("Refs #1")]],
      [5, [pullReference("Refs #5", false)]],
      [6, [pullReference("Related to #6")]],
    ]);
    const client = {
      authenticatedLogin: () => Effect.succeed("cogwork-bot"),
      listIssues: () =>
        Effect.succeed([
          issue(2, marker),
          issue(3, "ordinary issue"),
          issue(4, marker, "open", "untrusted-user"),
          issue(1, marker, "closed"),
          issue(5, marker, "closed"),
          issue(6, marker, "closed"),
          { ...issue(7, "malformed marker"), labels: ["origin:selfperf"] },
        ]),
      issuePullReferences: (_repo: unknown, issueNumber: number) =>
        Effect.succeed(references.get(issueNumber) ?? []),
    };

    const history = yield* performanceIssueHistory(client, {
      owner: "colonylabs",
      name: "cogwork",
      tokenEnv: "GITHUB_TOKEN",
    });

    assert.deepStrictEqual(
      history.map(({ id, state, fingerprint, hasMergedFix }) => ({ id, state, fingerprint, hasMergedFix })),
      [
        { id: "#1", state: "closed", fingerprint: performanceFingerprint, hasMergedFix: true },
        { id: "#2", state: "open", fingerprint: performanceFingerprint, hasMergedFix: false },
        { id: "#5", state: "closed", fingerprint: performanceFingerprint, hasMergedFix: false },
        { id: "#6", state: "closed", fingerprint: performanceFingerprint, hasMergedFix: false },
        { id: "#7", state: "open", fingerprint: undefined, hasMergedFix: false },
      ],
    );
  }),
);

it.effect("does not require an authenticated login for origin-labeled history", () =>
  Effect.gen(function* () {
    const client = {
      authenticatedLogin: unexpectedClientCall,
      listIssues: () =>
        Effect.succeed([{ ...issue(2, marker), labels: ["needs-triage", "origin:selfperf"] }]),
      issuePullReferences: noPullReferences,
    };

    const history = yield* performanceIssueHistory(client, {
      owner: "colonylabs",
      name: "cogwork",
      tokenEnv: "GITHUB_TOKEN",
    });

    assert.deepStrictEqual(
      history.map(({ id }) => id),
      ["#2"],
    );
  }),
);

it.effect("keeps marker-only login failures visible for authenticated targets", () =>
  Effect.gen(function* () {
    const failure = new IssueTrackerError({
      reason: "unavailable",
      retryable: true,
      message: "authenticated login is temporarily unavailable",
    });
    const client = {
      authenticatedLogin: () => Effect.fail(failure),
      listIssues: () => Effect.succeed([issue(2, marker)]),
      issuePullReferences: unexpectedClientCall,
    };

    const error = yield* Effect.flip(
      performanceIssueHistory(client, {
        owner: "colonylabs",
        name: "cogwork",
        tokenEnv: "GITHUB_TOKEN",
      }),
    );

    assert.strictEqual(error, failure);
  }),
);

it.effect("uses origin labels without actor lookup for installation-token targets", () =>
  Effect.gen(function* () {
    const client = {
      authenticatedLogin: unexpectedClientCall,
      listIssues: () => Effect.succeed([issue(2, marker)]),
      issuePullReferences: unexpectedClientCall,
    };

    const history = yield* performanceIssueHistory(
      client,
      { owner: "colonylabs", name: "cogwork", tokenEnv: "GITHUB_TOKEN" },
      "origin-label-only",
    );

    assert.deepStrictEqual(history, []);
  }),
);

it.effect("recognizes merged pull requests with GitHub closing keywords", () =>
  Effect.gen(function* () {
    const references = new Map([
      [1, [pullReference("Closes #1")]],
      [2, [pullReference("Fixes #2")]],
      [3, [pullReference("Resolves #3")]],
    ]);
    const client = {
      authenticatedLogin: () => Effect.succeed("cogwork-bot"),
      listIssues: () =>
        Effect.succeed([issue(1, marker, "closed"), issue(2, marker, "closed"), issue(3, marker, "closed")]),
      issuePullReferences: (_repo: unknown, issueNumber: number) =>
        Effect.succeed(references.get(issueNumber) ?? []),
    };

    const history = yield* performanceIssueHistory(client, {
      owner: "colonylabs",
      name: "cogwork",
      tokenEnv: "GITHUB_TOKEN",
    });

    assert.deepStrictEqual(
      history.map(({ hasMergedFix }) => hasMergedFix),
      [true, true, true],
    );
  }),
);

it.effect("repairs labels before confirming a created performance issue", () =>
  Effect.gen(function* () {
    const labels = yield* Ref.make<ReadonlyArray<string>>([]);
    const client = {
      addLabel: (_repo: unknown, _number: number, label: string) =>
        Ref.update(labels, (current) => [...current, label]),
      authenticatedLogin: () => Effect.succeed("cogwork-bot"),
      listIssues: () => Effect.succeed([issue(2, marker)]),
      issuePullReferences: noPullReferences,
    };

    yield* confirmPerformanceIssue(
      client,
      { owner: "colonylabs", name: "cogwork", tokenEnv: "GITHUB_TOKEN" },
      performanceFingerprint,
    );

    assert.deepStrictEqual(yield* Ref.get(labels), ["needs-triage", "origin:selfperf"]);
  }),
);

it.effect("confirms the accepted occurrence after it closes", () =>
  Effect.gen(function* () {
    const labeled = [issue(1_000, marker, "closed"), issue(2_000, marker, "closed")];
    const labeledNumbers = yield* Ref.make<ReadonlyArray<number>>([]);
    const client = {
      addLabel: (_repo: unknown, number: number) =>
        Ref.update(labeledNumbers, (current) => [...current, number]),
      authenticatedLogin: () => Effect.succeed("cogwork-bot"),
      listIssues: () => Effect.succeed(labeled),
      issuePullReferences: noPullReferences,
    };

    yield* confirmPerformanceIssue(
      client,
      { owner: "colonylabs", name: "cogwork", tokenEnv: "GITHUB_TOKEN" },
      performanceFingerprint,
      new Set([decodeWorkItemId("#1000")]),
    );

    assert.deepStrictEqual(yield* Ref.get(labeledNumbers), [2_000, 2_000]);
  }),
);

it.effect("builds a target from a GitHub client and repository reference", () =>
  Effect.gen(function* () {
    const created = yield* CreateIssueCalls;
    const target = yield* makePerformanceIssueFilerTarget(
      {
        addLabel: () => Effect.void,
        authenticatedLogin: () => Effect.succeed("cogwork-bot"),
        createIssue: () => Ref.update(created, (count) => count + 1),
        createPerformanceComment: unexpectedClientCall,
        issuePullReferences: noPullReferences,
        listIssues: () =>
          Ref.get(created).pipe(Effect.map((count) => (count === 0 ? [] : [issue(2, marker)]))),
      },
      { owner: "colonylabs", name: "cogwork", tokenEnv: "GITHUB_TOKEN" },
    );

    yield* target.create({
      fingerprint: performanceFingerprint,
      title: "Daemon event-loop delay p99 exceeded 100 ms",
      body: marker,
      labels: ["needs-triage", "origin:selfperf"],
    });

    assert.strictEqual(yield* Ref.get(created), 1);
  }).pipe(Effect.provide(CreateIssueCalls.layer)),
);

it.effect("retries creation after a transient failure that did not report acceptance", () =>
  Effect.gen(function* () {
    const filer = yield* PerformanceIssueFiler;
    const calls = yield* CreateIssueCalls;

    yield* Effect.flip(filer.submit(performanceVerdict, Date.UTC(2026, 8, 9, 15)));
    const result = yield* filer.submit(performanceVerdict, Date.UTC(2026, 8, 9, 15));

    assert.strictEqual(result, "filed");
    assert.strictEqual(yield* Ref.get(calls), 2);
  }).pipe(
    Effect.provide(
      layer(performanceWorkspaceName).pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            Layer.effect(
              GitHubClient,
              Effect.gen(function* () {
                const calls = yield* CreateIssueCalls;
                return {
                  authenticatedLogin: () => Effect.succeed("cogwork-bot"),
                  listIssues: () =>
                    Ref.get(calls).pipe(Effect.map((count) => (count >= 2 ? [issue(2, marker)] : []))),
                  readIssue: unexpectedClientCall,
                  listIssueFieldValues: unexpectedClientCall,
                  listPriorityFields: unexpectedClientCall,
                  issuePullReferences: noPullReferences,
                  addLabel: () => Effect.void,
                  createPerformanceComment: unexpectedClientCall,
                  listPulls: unexpectedClientCall,
                  pullMergeableState: unexpectedClientCall,
                  listComments: unexpectedClientCall,
                  listAllComments: unexpectedClientCall,
                  listReviewComments: unexpectedClientCall,
                  listReviews: unexpectedClientCall,
                  listCheckRuns: unexpectedClientCall,
                  createIssue: () =>
                    Ref.updateAndGet(calls, (count) => count + 1).pipe(
                      Effect.flatMap((count) =>
                        count === 1
                          ? Effect.fail(
                              new IssueTrackerError({
                                reason: "unavailable",
                                message: "transient create failure",
                              }),
                            )
                          : Effect.void,
                      ),
                    ),
                  createPull: unexpectedClientCall,
                  removeLabel: unexpectedClientCall,
                  createComment: unexpectedClientCall,
                  editComment: unexpectedClientCall,
                  verifyCredential: unexpectedClientCall,
                } satisfies GitHubClientService;
              }),
            ),
            Layer.succeed(
              WorkspaceRegistry,
              readOnlyRegistry({ workspaces: [performanceWorkspace], failures: [] }),
            ),
          ).pipe(Layer.provideMerge(CreateIssueCalls.layer)),
        ),
      ),
    ),
  ),
);

it.effect("keeps an unregistered performance workspace retryable", () =>
  Effect.gen(function* () {
    const filer = yield* PerformanceIssueFiler;
    const error = yield* Effect.flip(filer.submit(performanceVerdict, Date.UTC(2026, 8, 9, 15)));

    assert.strictEqual(error.reason, "unavailable");
    assert.isTrue(error.retryable);
  }).pipe(Effect.provide(filerLayer(performanceWorkspaceName, []))),
);

it.effect("rejects a missing performance workspace configuration permanently", () =>
  Effect.gen(function* () {
    const filer = yield* PerformanceIssueFiler;
    const error = yield* Effect.flip(filer.submit(performanceVerdict, Date.UTC(2026, 8, 9, 15)));

    assert.strictEqual(error.reason, "unavailable");
    assert.isFalse(error.retryable ?? true);
    assert.strictEqual(error.message, "performance evidence workspace is not configured");
  }).pipe(Effect.provide(filerLayer(undefined, []))),
);

it.effect("rejects a non-GitHub performance workspace permanently", () =>
  Effect.gen(function* () {
    const filer = yield* PerformanceIssueFiler;
    const error = yield* Effect.flip(filer.submit(performanceVerdict, Date.UTC(2026, 8, 9, 15)));

    assert.strictEqual(error.reason, "unavailable");
    assert.isFalse(error.retryable ?? true);
    assert.strictEqual(
      error.message,
      `performance evidence workspace ${linearPerformanceWorkspaceName} does not use GitHub issues`,
    );
  }).pipe(Effect.provide(filerLayer(linearPerformanceWorkspaceName, [linearPerformanceWorkspace]))),
);
