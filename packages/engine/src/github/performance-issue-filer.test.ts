import { WorkItemId, WorkspaceConfig, WorkspaceId } from "@cogwork/contracts";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { IssueTracker, IssueTrackerError, makeEmpty } from "../issue-tracker";
import { PerformanceIssueFiler, PerformanceIssueFingerprint } from "../performance-issue-filer";
import type { RegisteredWorkspace } from "../projector";
import { readOnlyRegistry, WorkspaceRegistry } from "../registry";
import { GitHubClient, type GitHubClientService } from "./client";
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

const unexpectedClientCall = () => Effect.die("unexpected GitHub client call");

it.effect("recovers an open marker-bearing issue whose labels were omitted during creation", () =>
  Effect.gen(function* () {
    const references = new Map([
      [1, [pullReference("Refs #1")]],
      [5, [pullReference("Refs #5", false)]],
      [6, [pullReference("Related to #6")]],
    ]);
    const client = {
      authenticatedLogin: () => Effect.succeed("cogwork-bot"),
      listIssues: (_repo: unknown, query?: { readonly state: "open" | "all"; readonly label?: string }) =>
        Effect.succeed(
          query?.label
            ? [issue(1, marker, "closed")]
            : [
                issue(2, marker),
                issue(3, "ordinary issue"),
                issue(4, marker, "open", "untrusted-user"),
                issue(1, marker, "closed"),
                issue(5, marker, "closed"),
                issue(6, marker, "closed"),
              ],
        ),
      issuePullReferences: (_repo: unknown, issueNumber: number) =>
        Effect.succeed(references.get(issueNumber) ?? []),
    };

    const history = yield* performanceIssueHistory(client, {
      owner: "colonylabs",
      name: "cogwork",
      tokenEnv: "GITHUB_TOKEN",
    });

    assert.deepStrictEqual(
      history.map(({ id, state, hasMergedFix }) => ({ id, state, hasMergedFix })),
      [
        { id: "#1", state: "closed", hasMergedFix: true },
        { id: "#2", state: "open", hasMergedFix: false },
        { id: "#5", state: "closed", hasMergedFix: false },
        { id: "#6", state: "closed", hasMergedFix: false },
      ],
    );
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
      listIssues: (_repo: unknown, query?: { readonly state: "open" | "all"; readonly label?: string }) =>
        Effect.succeed(query?.label ? [] : [issue(2, marker)]),
      issuePullReferences: noPullReferences,
    };

    yield* confirmPerformanceIssue(
      client,
      { owner: "colonylabs", name: "cogwork", tokenEnv: "GITHUB_TOKEN" },
      marker,
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
      marker,
      new Set([decodeWorkItemId("#1000")]),
    );

    assert.deepStrictEqual(yield* Ref.get(labeledNumbers), [2_000, 2_000]);
  }),
);

it.effect("retries creation after a transient failure that did not report acceptance", () =>
  Effect.gen(function* () {
    const filer = yield* PerformanceIssueFiler;
    const calls = yield* CreateIssueCalls;
    const input = {
      fingerprint: performanceFingerprint,
      title: "Daemon event-loop delay p99 exceeded 100 ms",
      body: "Signal: daemon event-loop delay p99 above threshold",
      recurrenceBody: "Fired again.",
    };

    yield* Effect.flip(filer.submit(input, Date.UTC(2026, 8, 9, 15)));
    const result = yield* filer.submit(input, Date.UTC(2026, 8, 9, 15));

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
                  listIssueFieldValues: unexpectedClientCall,
                  listPriorityFields: unexpectedClientCall,
                  issuePullReferences: noPullReferences,
                  addLabel: () => Effect.void,
                  createPerformanceComment: unexpectedClientCall,
                  listPulls: unexpectedClientCall,
                  pullMergeableState: unexpectedClientCall,
                  listComments: unexpectedClientCall,
                  listReviewComments: unexpectedClientCall,
                  listReviews: unexpectedClientCall,
                  listCheckRuns: unexpectedClientCall,
                  createIssue: unexpectedClientCall,
                  createPull: unexpectedClientCall,
                  removeLabel: unexpectedClientCall,
                  createComment: unexpectedClientCall,
                  editComment: unexpectedClientCall,
                  verifyCredential: unexpectedClientCall,
                } satisfies GitHubClientService;
              }),
            ),
            Layer.effect(
              IssueTracker,
              Effect.gen(function* () {
                const calls = yield* CreateIssueCalls;
                const base = yield* makeEmpty;
                return {
                  ...base,
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
                };
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
