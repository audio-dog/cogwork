import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { wireCodec } from "./markers";
import { performanceIssueHistory } from "./performance-issue-filer";

const marker = wireCodec.encode({
  name: "selfperf",
  pairs: "fingerprint=daemon.event-loop-delay-p99.above",
});

const issue = (number: number, body: string, state: "open" | "closed" = "open") => ({
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
});

it.effect("recovers an open marker-bearing issue whose labels were omitted during creation", () =>
  Effect.gen(function* () {
    const client = {
      listIssues: (_repo: unknown, query?: { readonly state: "open" | "all"; readonly label?: string }) =>
        Effect.succeed(
          query?.label
            ? [issue(1, marker, "closed")]
            : [issue(2, marker), issue(3, "ordinary issue"), issue(1, marker, "closed")],
        ),
    };

    const history = yield* performanceIssueHistory(client, {
      owner: "colonylabs",
      name: "cogwork",
      tokenEnv: "GITHUB_TOKEN",
    });

    assert.deepStrictEqual(
      history.map(({ id, state }) => ({ id, state })),
      [
        { id: "#1", state: "closed" },
        { id: "#2", state: "open" },
      ],
    );
  }),
);
