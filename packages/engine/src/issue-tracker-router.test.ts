import { WorkItemId, WorkspaceConfig } from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { IssueTracker, type IssueTrackerService } from "./issue-tracker";
import { route } from "./issue-tracker-router";
import type { RegisteredWorkspace } from "./projector";

const id = Schema.decodeSync(WorkItemId);

const workspaceOf = (
  name: string,
  issueTracker: { readonly type: string; readonly teams?: ReadonlyArray<string> },
): RegisteredWorkspace => ({
  source: `${name}.workspace.ts`,
  contributions: [],
  config: Schema.decodeSync(WorkspaceConfig)({
    name,
    checkoutPath: `/repos/${name}`,
    issueTracker,
  }),
});

const githubWorkspace = workspaceOf("gh", { type: "github" });
const linearWorkspace = workspaceOf("lin", { type: "linear", teams: ["AUD"] });

type Recorded = {
  readonly source: string;
  readonly action: "attemptFailed";
  readonly reason: string | undefined;
};

class RouterCalls extends Context.Service<RouterCalls, Ref.Ref<ReadonlyArray<Recorded>>>()(
  "@cogwork/engine/issue-tracker-router.test/RouterCalls",
) {
  static readonly layer = Layer.effect(RouterCalls, Ref.make<ReadonlyArray<Recorded>>([]));
}

const fakeSource = (source: string, calls: Ref.Ref<ReadonlyArray<Recorded>>): IssueTrackerService => ({
  rateLimitScope: () => null,
  observe: () => Effect.succeed([]),
  readProse: () => Effect.succeed({ body: "", comments: [] }),
  claim: () => Effect.void,
  release: () => Effect.void,
  note: () => Effect.void,
  triaged: () => Effect.void,
  implemented: () => Effect.void,
  followedUp: () => Effect.void,
  attemptFailed: (_workspace, _id, outcome) =>
    Ref.update(calls, (recorded) => [
      ...recorded,
      {
        source,
        action: "attemptFailed",
        reason: outcome.reason,
      } satisfies Recorded,
    ]),
  handOff: () => Effect.void,
  handBack: () => Effect.void,
  stalled: () => Effect.void,
  reclassify: () => Effect.void,
});

const routerLayer = () =>
  Layer.effect(
    IssueTracker,
    Effect.map(RouterCalls, (calls) => route(fakeSource("github", calls), fakeSource("linear", calls))),
  ).pipe(Layer.provideMerge(RouterCalls.layer));

describe("issueTrackerRouter", () => {
  it.effect("forwards the failure reason to the adapter for the workspace's source", () =>
    Effect.gen(function* () {
      const calls = yield* RouterCalls;
      const router = yield* IssueTracker;
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
      assert.deepStrictEqual(yield* Ref.get(calls), [
        {
          source: "github",
          action: "attemptFailed",
          reason: "git worktree add: boom",
        },
        {
          source: "linear",
          action: "attemptFailed",
          reason: "pnpm install: exit 1",
        },
      ]);
    }).pipe(Effect.provide(routerLayer())),
  );

  it.effect("leaves the reason undefined when the caller has none", () =>
    Effect.gen(function* () {
      const calls = yield* RouterCalls;
      const router = yield* IssueTracker;
      yield* router.attemptFailed(githubWorkspace, id("#7"), { stage: "implement", atMillis: 1 });
      assert.deepStrictEqual(yield* Ref.get(calls), [
        { source: "github", action: "attemptFailed", reason: undefined },
      ]);
    }).pipe(Effect.provide(routerLayer())),
  );
});
