import { assert, describe, it } from "@effect/vitest";
import * as Result from "effect/Result";

import { WorkItemId, WorkspaceId } from "./base-schemas";
import { ConnectionId } from "./connection";
import { keyOf, parseWorkItemReference, refOfKey, WorkItemKey, type WorkItemRef } from "./coordination";
import { RunId } from "./run";

const workspace = WorkspaceId.make("acme:web");

const refs: ReadonlyArray<WorkItemRef> = [
  { _tag: "Issue", workspace, id: WorkItemId.make("#12") },
  { _tag: "PullRequest", workspace, number: 7 },
  { _tag: "GranolaNote", connection: ConnectionId.make("granola/me"), noteId: "note:1" },
  { _tag: "SlackMessage", team: "T1", channel: "C1", ts: "1700.01" },
  { _tag: "SlackConversation", team: "T1", channel: "C1", threadTs: "1700.01" },
  { _tag: "ScheduleInstant", workflow: "nightly", instantMillis: 1_700_000_000_000 },
  {
    _tag: "FanOutChild",
    parent: WorkItemKey.make("issue:acme%3Aweb:%2312"),
    run: RunId.make("run-1"),
    position: 2,
  },
];

describe("refOfKey", () => {
  it.each(refs)("decodes the key of a $_tag back to its ref", (ref) => {
    assert.deepStrictEqual(refOfKey(keyOf(ref)), ref);
  });

  it.each(["", "unknown:a", "issue:only-workspace", "pull-request:web:not-a-number", "issue:%E0:x"])(
    "returns null for %j",
    (key) => {
      assert.isNull(refOfKey(key));
    },
  );
});

describe("parseWorkItemReference", () => {
  const issue = (id: string): WorkItemRef => ({ _tag: "Issue", workspace, id: WorkItemId.make(id) });

  it.each([
    ["#1048", issue("#1048")],
    [" AUD-1 ", issue("AUD-1")],
    ["https://github.com/audio-dog/cogwork/issues/1187", issue("#1187")],
    ["https://github.com/audio-dog/cogwork/issues/1187#issuecomment-1", issue("#1187")],
    ["https://github.com/audio-dog/cogwork/pull/12/files", { _tag: "PullRequest", workspace, number: 12 }],
    ["https://linear.app/audio-dog/issue/AUD-1/start-over", issue("AUD-1")],
  ] as const)("reads %j", (reference, expected) => {
    assert.deepStrictEqual(Result.getOrThrow(parseWorkItemReference(workspace, reference)), expected);
  });

  it.each([
    "",
    "1048",
    "#0",
    "aud-1",
    "https://github.com/audio-dog/cogwork",
    "https://gitlab.com/audio-dog/cogwork/issues/1",
    "https://linear.app/audio-dog/project/AUD-1",
  ])("refuses %j with a message", (reference) => {
    const parsed = parseWorkItemReference(workspace, reference);
    assert.isTrue(Result.isFailure(parsed));
    assert.include(Result.getOrThrow(Result.flip(parsed)), "is not a work item reference");
  });
});
