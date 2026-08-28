import { WorkItemId, WorkspaceConfig } from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { IssueTrackerService } from "./issue-tracker";
import { route } from "./issue-tracker-router";
import type { RegisteredWorkspace } from "./projector";

const id = Schema.decodeSync(WorkItemId);

const workspaceOf = (
  name: string,
  issueTracker: { readonly type: string; readonly repo?: string; readonly teams?: ReadonlyArray<string> },
): RegisteredWorkspace => ({
  source: `${name}.workspace.ts`,
  contributions: [],
  config: Schema.decodeSync(WorkspaceConfig)({
    name,
    checkoutPath: `/repos/${name}`,
    issueTracker,
    harness: { preferred: "cursor" },
  }),
});

const githubWorkspace = workspaceOf("gh", { type: "github", repo: "acme/app" });
const linearWorkspace = workspaceOf("lin", { type: "linear", teams: ["AUD"] });

interface Recorded {
  readonly source: string;
  readonly reason: string | undefined;
}

const fakeSource = (source: string, log: Array<Recorded>) =>
  ({
    observe: () => Effect.succeed([]),
    claim: () => Effect.void,
    release: () => Effect.void,
    note: () => Effect.void,
    triaged: () => Effect.void,
    implemented: () => Effect.void,
    followedUp: () => Effect.void,
    attemptFailed: (
      _workspace: RegisteredWorkspace,
      _id: WorkItemId,
      outcome: { readonly reason?: string },
    ) => Effect.sync(() => void log.push({ source, reason: outcome.reason })),
    handOff: () => Effect.void,
    stalled: () => Effect.void,
    reclassify: () => Effect.void,
  }) as unknown as IssueTrackerService;

describe("issueTrackerRouter", () => {
  it.effect("forwards the failure reason to the adapter for the workspace's source", () =>
    Effect.gen(function* () {
      const log: Array<Recorded> = [];
      const router = route(fakeSource("github", log), fakeSource("linear", log));
      yield* router.attemptFailed(githubWorkspace, id("#7"), {
        stage: "implement",
        atMillis: 1,
        reason: "git worktree add: boom",
      });
      yield* router.attemptFailed(linearWorkspace, id("AUD-7"), {
        stage: "implement",
        atMillis: 1,
        reason: "pnpm install: exit 1",
      });
      assert.deepStrictEqual(log, [
        { source: "github", reason: "git worktree add: boom" },
        { source: "linear", reason: "pnpm install: exit 1" },
      ]);
    }),
  );

  it.effect("leaves the reason undefined when the caller has none", () =>
    Effect.gen(function* () {
      const log: Array<Recorded> = [];
      const router = route(fakeSource("github", log), fakeSource("linear", log));
      yield* router.attemptFailed(githubWorkspace, id("#7"), { stage: "implement", atMillis: 1 });
      assert.deepStrictEqual(log, [{ source: "github", reason: undefined }]);
    }),
  );
});
