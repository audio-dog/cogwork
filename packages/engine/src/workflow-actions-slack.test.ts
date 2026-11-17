import {
  keyOf,
  WorkflowActionTarget,
  WorkflowCatalogKey,
  WorkflowId,
  WorkflowNodeId,
  type WorkflowParameterValue,
  WorkItemId,
  type WorkItemRef,
  WorkspaceId,
} from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { TriggerAdmission } from "./trigger-observation";
import { actionEntryFor } from "./workflow-action-registry";

const decodeEntry = Schema.decodeSync(WorkflowCatalogKey);

const admissionFor = (ref: WorkItemRef): TriggerAdmission => {
  const entry = decodeEntry("slack.i-am-mentioned");
  return {
    event: { key: ref, revision: "1", cause: { _tag: "Unknown" }, atMillis: 1, entry, workspace: null },
    subscription: {
      workflow: Schema.decodeSync(WorkflowId)("slack-writes"),
      trigger: Schema.decodeSync(WorkflowNodeId)("mentioned"),
      operation: Schema.decodeSync(WorkflowNodeId)("write"),
      entry,
      parameters: [],
      filters: [],
      workspaces: [],
      catchUp: { since: 0 },
    },
    lineage: {
      root: Schema.decodeSync(Schema.String.pipe(Schema.brand("LineageId")))(keyOf(ref)),
      parent: null,
      hop: 0,
    },
  };
};

const targetOf = (
  action: string,
  ref: WorkItemRef,
  parameters: ReadonlyArray<WorkflowParameterValue> = [],
) => {
  const entry = actionEntryFor(`slack.${action}`);
  assert.isDefined(entry);
  return entry.target({
    entry: entry.row,
    admission: admissionFor(ref),
    workspaces: [],
    inputs: {},
    parameters,
    workspace: undefined,
    sourceControl: undefined,
  });
};

const threadReply = {
  _tag: "SlackMessage",
  team: "T1",
  channel: "C1",
  ts: "901.000",
  threadTs: "900.000",
} as const;
const conversation = { _tag: "SlackConversation", team: "T1", channel: "C1", threadTs: "900.000" } as const;
const issue = {
  _tag: "Issue",
  workspace: Schema.decodeSync(WorkspaceId)("repo"),
  id: Schema.decodeSync(WorkItemId)("#904"),
} as const;
const decodeTarget = Schema.decodeUnknownSync(WorkflowActionTarget);

describe("Slack Action entries", () => {
  it.effect("freezes the thread root of a threaded Slack item", () =>
    Effect.gen(function* () {
      const threaded = { _tag: "SlackMessage", team: "T1", channel: "C1", threadTs: "900.000" };
      assert.deepStrictEqual(
        yield* targetOf("reply-in-thread", threadReply),
        decodeTarget({ ...threaded, ts: "901.000" }),
      );
      assert.deepStrictEqual(
        yield* targetOf("draft-reply-in-slack", conversation),
        decodeTarget({ ...threaded, ts: "900.000" }),
      );
    }),
  );

  it.effect("refuses a Slack target it cannot freeze", () =>
    Effect.gen(function* () {
      const refusals = [
        {
          action: "add-reaction",
          ref: issue,
          parameters: [],
          message: "The Slack action needs a Slack item",
        },
        {
          action: "send-message",
          ref: issue,
          parameters: [{ id: "channel", value: "  " }],
          message: "The Slack message action needs a channel",
        },
      ];
      const failures = yield* Effect.forEach(refusals, ({ action, ref, parameters }) =>
        Effect.flip(targetOf(action, ref, parameters)),
      );
      assert.deepStrictEqual(
        failures.map(({ reason, message }) => ({ reason, message })),
        refusals.map(({ message }) => ({ reason: "invalid", message })),
      );
    }),
  );
});
