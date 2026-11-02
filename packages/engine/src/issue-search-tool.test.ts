import { WorkItemId, WorkspaceConfig } from "@cogwork/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { IssueSearchInput, makeIssueSearchTool } from "./issue-search-tool";
import { makeEmpty } from "./issue-tracker";
import type { RegisteredWorkspace } from "./projector";

const workspace: RegisteredWorkspace = {
  source: "test",
  contributions: [],
  config: Schema.decodeSync(WorkspaceConfig)({
    name: "cogwork",
    checkoutPath: "/cogwork",
    issueTracker: { type: "github" },
  }),
};

it.effect("rejects blank and oversized issue searches", () =>
  Effect.forEach([" ", "x".repeat(201)], (query) =>
    Schema.decodeEffect(IssueSearchInput)({ query }).pipe(
      Effect.result,
      Effect.map((decoded) => assert.isTrue(Result.isFailure(decoded))),
    ),
  ),
);

it.effect("searches supplied Workspace issue titles", () =>
  Effect.gen(function* () {
    const base = yield* makeEmpty;
    const tool = makeIssueSearchTool(
      {
        ...base,
        observe: () =>
          Effect.succeed([
            {
              claimHeld: false,
              claim: null,
              claimedByUs: false,
              attempts: [],
              handback: null,
              id: WorkItemId.make("#813"),
              title: "Fan out Workflow results",
              url: "https://example.test/issues/813",
              roles: [],
              assignees: [],
              openBlockers: 0,
              proposal: null,
              priority: "medium" as const,
              followUp: null,
            },
          ]),
        readProse: () => Effect.succeed({ body: "Create one child per commitment.", comments: [] }),
      },
      [workspace],
    );
    const execute = tool.execute;
    if (execute === undefined) throw new Error("issue search tool is missing a server executor");
    const searched = yield* Effect.promise(() => Promise.resolve(execute({ query: "fan workflow" })));

    assert.deepStrictEqual(searched, {
      matches: [
        {
          workspace: "cogwork",
          id: "#813",
          title: "Fan out Workflow results",
          url: "https://example.test/issues/813",
          body: "Create one child per commitment.",
        },
      ],
    });
  }),
);

it.effect("bounds issue reads and returned prose", () =>
  Effect.gen(function* () {
    const base = yield* makeEmpty;
    const proseReads = yield* Ref.make(0);
    const items = Array.from({ length: 25 }, (_, index) => ({
      claimHeld: false,
      claim: null,
      claimedByUs: false,
      attempts: [],
      handback: null,
      id: WorkItemId.make(`#${index + 1}`),
      title: `Matching issue ${index + 1}`,
      url: `https://example.test/issues/${index + 1}`,
      roles: [],
      assignees: [],
      openBlockers: 0,
      proposal: null,
      priority: "medium" as const,
      followUp: null,
    }));
    const tool = makeIssueSearchTool(
      {
        ...base,
        observe: () => Effect.succeed(items),
        readProse: () =>
          Ref.update(proseReads, (count) => count + 1).pipe(
            Effect.map(() => ({ body: "x".repeat(5_000), comments: [] })),
          ),
      },
      [workspace],
    );
    const execute = tool.execute;
    if (execute === undefined) throw new Error("issue search tool is missing a server executor");
    const searched = yield* Effect.promise(() => Promise.resolve(execute({ query: "matching" }))).pipe(
      Effect.flatMap(
        Schema.decodeUnknownEffect(
          Schema.Struct({ matches: Schema.Array(Schema.Struct({ body: Schema.String })) }),
        ),
      ),
    );

    assert.lengthOf(searched.matches, 20);
    assert.strictEqual(yield* Ref.get(proseReads), 20);
    assert.isTrue(searched.matches.every(({ body }) => body.length === 4_000));
  }),
);
