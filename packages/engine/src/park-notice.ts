import { keyOf, type ParkReason, type WorkflowParkCommand, type WorkItemRef } from "@cogwork/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import type { CoordinationService } from "./coordination";
import { IssueTracker } from "./issue-tracker";
import { findWorkspace, WorkspaceRegistry } from "./registry";
import { parkCommandsByReason, parkSummary } from "./workflow-attention";

const commandPhrases = {
  approve: "approve the plan",
  reject: "reject the plan",
  "choose-answer": "choose an answer",
  "open-workflow": "open the Workflow and correct its Operation",
  "hand-back": "select **Hand back** and add a note for the next Run",
} satisfies Record<WorkflowParkCommand, string>;

const orList = new Intl.ListFormat("en", { type: "disjunction" });

// These reasons carry raw failure text; the tracker can be public, so the text stays in Cogwork.
const heldSummaries: Partial<Record<ParkReason["_tag"], string>> = {
  Exhausted:
    "The Operation failed too many times in a row. Cogwork shows the last error under **Attention**.",
  WriteFailed: "A Workflow write failed. Cogwork shows the error under **Attention**.",
};

const trackerSummary = (reason: ParkReason) => heldSummaries[reason._tag] ?? parkSummary(reason);

const parkNoticeBody = (reason: ParkReason) =>
  [
    "Cogwork stopped work on this item. A person must act before it runs again.",
    `**Reason:** ${trackerSummary(reason)}`,
    `**What to do:** Open **Attention** in Cogwork, find this item, and ${orList.format(
      parkCommandsByReason[reason._tag].map((command) => commandPhrases[command]),
    )}.`,
  ].join("\n\n");

export const withParkNotices = Effect.fn("ParkNotice.withParkNotices")(function* <E, R>(
  makeCoordination: Effect.Effect<CoordinationService, E, R>,
) {
  const coordination = yield* makeCoordination;
  const tracker = yield* IssueTracker;
  const registry = yield* WorkspaceRegistry;
  const notices = yield* FiberSet.make();

  const post = Effect.fn("ParkNotice.post")(
    function* (ref: WorkItemRef, reason: ParkReason) {
      if (ref._tag !== "Issue") return;
      const workspace = findWorkspace(yield* registry.state, ref.workspace);
      if (!workspace) return yield* Effect.logWarning("Park notice skipped: the Workspace is not registered");
      const atMillis = yield* Clock.currentTimeMillis;
      yield* tracker.commentIssue(
        workspace,
        ref.id,
        parkNoticeBody(reason),
        `park:${keyOf(ref)}:${atMillis}`,
      );
    },
    (effect) =>
      effect.pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) => Effect.logWarning("Park notice was not posted", { cause }),
        ),
      ),
    (effect, ref) => effect.pipe(Effect.annotateLogs({ item: keyOf(ref) })),
  );

  return {
    ...coordination,
    park: (ref, reason, operation) =>
      coordination
        .park(ref, reason, operation)
        .pipe(Effect.tap(() => FiberSet.run(notices, post(ref, reason)))),
  } satisfies CoordinationService;
});
