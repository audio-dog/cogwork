import { WorkflowCatalogEntry, WorkflowNodeId, WorkflowOperation } from "@cogwork/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";

import { outcomeEdits } from "./workflow-edits";

const decodeNodeId = Schema.decodeUnknownSync(WorkflowNodeId);
const decodeEntry = Schema.decodeUnknownSync(WorkflowCatalogEntry);
const decodeOperation = Schema.decodeUnknownSync(WorkflowOperation);

const entry = (key: string, permissionProfile: "read-only" | "full") =>
  decodeEntry({
    key,
    name: key,
    kind: "action",
    system: null,
    connection: null,
    requires: [],
    parameters: [],
    itemKind: null,
    actsOn: ["*"],
    requiresWorkspace: false,
    workspaceSource: null,
    permissionProfile,
    agentInputs: [],
    emits: [],
  });

const openPullRequest = entry("github.open-pull-request", "full");
const comment = entry("github.comment-this-item", "read-only");
const entries = [openPullRequest, comment];

const operation = decodeOperation({
  id: "implement",
  name: "Implement",
  instructionPackage: null,
  instruction: "Do the work.",
  permissionProfile: "read-only",
  commands: { allow: [], deny: [] },
  connections: [],
  requires: [],
  model: { harness: null, model: null, options: [] },
  forEach: null,
  questions: [],
  transitions: [{ when: [], actions: [{ entry: comment.key, parameters: [] }], handOff: null }],
  hints: [],
});

describe("outcomeEdits", () => {
  it("raises the permission profile in the batch that adds an action needing it", () => {
    const answer = [{ question: decodeNodeId("ready"), choice: decodeNodeId("yes") }];
    expect(
      outcomeEdits.addAction(operation, answer, { entry: openPullRequest.key, parameters: [] }, entries),
    ).toEqual([
      { _tag: "AddTransition", operation: operation.id, when: answer },
      {
        _tag: "SetTransitionActions",
        operation: operation.id,
        when: answer,
        actions: [{ entry: openPullRequest.key, parameters: [] }],
      },
      { _tag: "SetPermissionProfile", operation: operation.id, profile: "full" },
    ]);
  });

  it("lowers the permission profile when the last action needing it goes", () => {
    const full = decodeOperation({
      ...operation,
      permissionProfile: "full",
      transitions: [{ when: [], actions: [{ entry: openPullRequest.key, parameters: [] }], handOff: null }],
    });
    expect(outcomeEdits.removeAction(full, [], 0, entries)).toEqual([
      { _tag: "SetTransitionActions", operation: full.id, when: [], actions: [] },
      { _tag: "SetPermissionProfile", operation: full.id, profile: "read-only" },
    ]);
  });
});
