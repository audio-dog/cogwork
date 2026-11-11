import { keyOf, type ParkReason, type WorkflowParkCommand, type WorkItemRef } from "@cogwork/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import type { CoordinationService } from "./coordination";
import { IssueTracker } from "./issue-tracker";
import { WorkspaceRegistry } from "./registry";
import { parkCommandsByReason, parkSummary } from "./workflow-attention";

const commandPhrases = {
  approve: "approve the plan",
  reject: "reject the plan",
  "choose-answer": "choose an answer",
  "open-workflow": "open the Workflow and correct its Operation",
  "hand-back": "select **Hand back** and add a note for the next Run",
} satisfies Record<WorkflowParkCommand, string>;

const choices = (phrases: ReadonlyArray<string>) =>
  phrases.length < 2 ? phrases.join("") : `${phrases.slice(0, -1).join(", ")}, or ${phrases.at(-1)}`;

// An exhausted reason is the raw failure Cause; the tracker can be public, so it stays in Cogwork.
const trackerSummary = (reason: ParkReason) =>
  reason._tag === "Exhausted"
    ? "The Operation failed too many times in a row. Cogwork shows the last error under **Attention**."
    : parkSummary(reason);

export const parkNoticeBody = (reason: ParkReason) =>
  [
    "Cogwork stopped work on this item. A person must act before it runs again.",
    `**Reason:** ${trackerSummary(reason)}`,
    `**What to do:** Open **Attention** in Cogwork, find this item, and ${choices(
      parkCommandsByReason[reason._tag].map((command) => commandPhrases[command]),
    )}.`,
  ].join("\n\n");

export const withParkNotices = Effect.fn("ParkNotice.withParkNotices")(function* <E, R>(
  makeCoordination: Effect.Effect<CoordinationService, E, R>,
) {
  const coordination = yield* makeCoordination;
  const tracker = yield* IssueTracker;
  const registry = yield* WorkspaceRegistry;

  const post = Effect.fn("ParkNotice.post")(function* (ref: WorkItemRef, reason: ParkReason) {
    if (ref._tag !== "Issue") return;
    const { workspaces } = yield* registry.state;
    const workspace = workspaces.find(({ config }) => config.name === ref.workspace);
    if (!workspace) {
      return yield* Effect.logWarning("Park notice skipped: the Workspace is not registered", {
        item: keyOf(ref),
      });
    }
    const atMillis = yield* Clock.currentTimeMillis;
    yield* tracker.commentIssue(workspace, ref.id, parkNoticeBody(reason), `park:${keyOf(ref)}:${atMillis}`);
  });

  return {
    ...coordination,
    park: (ref, reason, operation) =>
      coordination
        .park(ref, reason, operation)
        .pipe(
          Effect.tap(() =>
            post(ref, reason).pipe(
              Effect.catch((error) =>
                Effect.logWarning("Park notice was not posted", { item: keyOf(ref), error }),
              ),
            ),
          ),
        ),
  } satisfies CoordinationService;
});
