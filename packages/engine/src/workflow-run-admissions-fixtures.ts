import * as Schema from "effect/Schema";
import type { TriggerAdmission } from "./trigger-observation";
import {
  operation,
  scheduleEntry,
  siblingTrigger,
  trigger,
  workflow,
} from "./workflow-run-documents-fixtures";

export const admission: TriggerAdmission = {
  event: {
    key: { _tag: "ScheduleInstant", workflow, instantMillis: 1_000 },
    revision: "1000",
    cause: { _tag: "Unknown" },
    atMillis: 1_000,
    entry: scheduleEntry,
    workspace: null,
    workContext: {
      body: "Slack conversation in #reviews\nPermalink: https://example.slack.com/message",
      comments: [
        {
          author: "Taylor",
          authorAssociation: null,
          body: "Please review this.",
          createdAtMillis: 900,
        },
      ],
    },
  },
  subscription: {
    workflow,
    trigger,
    operation,
    entry: scheduleEntry,
    parameters: [],
    filters: [],
    workspaces: [],
    catchUp: { since: 0 },
  },
  lineage: {
    root: Schema.decodeSync(Schema.String.pipe(Schema.brand("LineageId")))("schedule:1000"),
    parent: null,
    hop: 0,
  },
};

export const granolaAdmission: TriggerAdmission = {
  ...admission,
  event: {
    ...admission.event,
    key: {
      _tag: "GranolaNote",
      connection: Schema.decodeSync(Schema.String.pipe(Schema.brand("ConnectionId")))(
        "granola/person@example.com",
      ),
      noteId: "note-1",
    },
    revision: "2026-10-29T15:00:00.000Z",
    atMillis: Date.UTC(2026, 9, 29, 15),
    workContext: undefined,
    payload: {
      _tag: "GranolaNote",
      title: "Weekly product sync",
      attendees: ["Taylor <taylor@example.com>", "Ari <ari@example.com>"],
      calendarEvent: "Weekly product sync · 2026-10-29 09:00 MDT",
      summary: "Decided to ship the smaller change.",
      transcript: "Taylor: Ship the smaller change.\nAri: Agreed.",
    },
  },
};

export const siblingGranolaAdmission: TriggerAdmission = {
  ...granolaAdmission,
  subscription: { ...granolaAdmission.subscription, trigger: siblingTrigger },
};
