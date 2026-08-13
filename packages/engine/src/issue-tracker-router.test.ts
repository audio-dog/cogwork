import { type AttemptRecord, WorkItemId, WorkspaceConfig } from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { IssueTrackerService } from "./issue-tracker";
import { route } from "./issue-tracker-router";
import type { RegisteredWorkspace } from "./projector";

const id = Schema.decodeSync(WorkItemId);

const workspaceOf = (
  name: string,
  issueTracker: { readonly type: string; readonly repo?: string; readonly team?: string },
): RegisteredWorkspace => ({
  source: `${name}.workspace.ts`,
  config: Schema.decodeSync(WorkspaceConfig)({
    name,
    checkoutPath: `/repos/${name}`,
    issueTracker,
    harness: { preferred: "cursor" },
  }),
});

const githubWorkspace = workspaceOf("gh", { type: "github", repo: "acme/app" });
const linearWorkspace = workspaceOf("lin", { type: "linear", team: "AUD" });

interface Recorded {
  readonly source: string;
  readonly reason: string | undefined;
}

const fakeSource = (source: string, log: Array<Recorded>) =>
  ({
    observe: () => Effect.succeed([]),
    claim: () => Effect.void,
    release: () => Effect.void,
    recordAttempt: (
      _workspace: RegisteredWorkspace,
      _id: WorkItemId,
      _attempt: AttemptRecord,
      reason?: string,
    ) => Effect.sync(() => void log.push({ source, reason })),
    recordFollowUp: () => Effect.void,
    note: () => Effect.void,
    setRoles: () => Effect.void,
  }) as unknown as IssueTrackerService;

const attempt: AttemptRecord = { stage: "implement", outcome: "failed", atMillis: 1 };

describe("issueTrackerRouter", () => {
  it.effect("forwards the failure reason to the adapter for the workspace's source", () =>
    Effect.gen(function* () {
      const log: Array<Recorded> = [];
      const router = route(fakeSource("github", log), fakeSource("linear", log));
      yield* router.recordAttempt(githubWorkspace, id("#7"), attempt, "git worktree add: boom");
      yield* router.recordAttempt(linearWorkspace, id("AUD-7"), attempt, "pnpm install: exit 1");
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
      yield* router.recordAttempt(githubWorkspace, id("#7"), attempt);
      assert.deepStrictEqual(log, [{ source: "github", reason: undefined }]);
    }),
  );
});
