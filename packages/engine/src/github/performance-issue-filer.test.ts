import { WorkItemId } from "@cogwork/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { wireCodec } from "./markers";
import { confirmPerformanceIssue, performanceIssueHistory } from "./performance-issue-filer";

const marker = wireCodec.encode({
  name: "selfperf",
  pairs: "fingerprint=daemon.event-loop-delay-p99.above",
});
const decodeWorkItemId = Schema.decodeSync(WorkItemId);
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
