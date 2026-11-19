import { WorkflowCatalogKey, WorkflowId, WorkflowNodeId, WorkItemId, WorkspaceId } from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import {
  event,
  otherWorkflowId,
  scheduleParameters,
  selectedEvent,
  selectedWorkspaceId,
  subscription,
} from "./trigger-observation-fixtures";
import { matchTriggerEvent } from "./trigger-observation-subscriptions";

describe("TriggerObservation", () => {
  it("matches a schedule event to one Trigger with the scheduled parameters", () => {
    const other = { ...subscription, workflow: Schema.decodeSync(WorkflowId)("other") };
    const later = {
      ...subscription,
      trigger: Schema.decodeSync(WorkflowNodeId)("later"),
      operation: Schema.decodeSync(WorkflowNodeId)("later-operation"),
      parameters: scheduleParameters.map((parameter) =>
        parameter.id === "hour" ? { ...parameter, value: "1" } : parameter,
      ),
    };

    assert.deepStrictEqual(matchTriggerEvent([later, subscription, other], event), [subscription]);
  });

  it("does not treat an empty Workspace selection as every Workspace", () => {
    const workspaceEvent = {
      ...event,
      key: {
        _tag: "Issue" as const,
        workspace: Schema.decodeSync(WorkspaceId)("selected"),
        id: Schema.decodeSync(WorkItemId)("#1"),
      },
      workspace: Schema.decodeSync(WorkspaceId)("selected"),
    };

    assert.deepStrictEqual(matchTriggerEvent([subscription], workspaceEvent), []);
  });

  it("matches a source event only to the Trigger whose parameters produced it", () => {
    const selected = {
      ...subscription,
      entry: Schema.decodeSync(WorkflowCatalogKey)("slack.i-am-mentioned"),
      parameters: [{ id: "channel", value: "C123" }],
    };
    const other = { ...selected, parameters: [{ id: "channel", value: "C456" }] };
    const slackEvent = {
      ...event,
      key: { _tag: "SlackMessage", team: "T123", channel: "C123", ts: "900.000" } as const,
      entry: selected.entry,
      parameters: selected.parameters,
    };

    assert.deepStrictEqual(matchTriggerEvent([other, selected], slackEvent), [selected]);
  });

  it("matches a targeted sweep item only to its Workflow Trigger", () => {
    const selected = {
      ...subscription,
      entry: Schema.decodeSync(WorkflowCatalogKey)("schedule.sweep"),
      workspaces: [selectedWorkspaceId],
    };
    const other = { ...selected, workflow: otherWorkflowId };
    const sweepEvent = {
      ...selectedEvent,
      entry: selected.entry,
      target: { workflow: selected.workflow, trigger: selected.trigger },
    };

    assert.deepStrictEqual(matchTriggerEvent([other, selected], sweepEvent), [selected]);
  });
});
