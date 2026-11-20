import {
  applyDaemonEvent,
  DaemonEvent,
  initialBoard,
  PrincipalId,
  WorkflowDocument,
  WorkflowId,
  type WorkflowRecord,
  WorkspaceId,
} from "@cogwork/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { operationNameOf, queuedItems, recentlyDone } from "./feed";

const decodeDaemonEvent = Schema.decodeUnknownSync(DaemonEvent);
const decodeWorkflowId = Schema.decodeUnknownSync(WorkflowId);

describe("recentlyDone", () => {
  it("includes a pull request creation decline", () => {
    const event = decodeDaemonEvent({
      _tag: "RunChanged",
      emittedAtMillis: 0,
      run: {
        id: "run-1",
        workspace: "acme",
        workItem: "1",
        operation: "implement",
        harness: "codex",
        branch: "1-fix",
        session: null,
        usage: null,
        status: "declined",
        startedAtMillis: 1,
        endedAtMillis: 2,
        eventCount: 0,
        eventsPrunedAtMillis: null,
      },
    });
    const board = applyDaemonEvent(initialBoard, event);

    expect(recentlyDone(board, null).map(({ run }) => run.status)).toEqual(["declined"]);
  });
});

describe("queuedItems", () => {
  it("keeps the scheduler's order and place inside the Workspace filter", () => {
    const queued = (place: number, workspace: string, workItem: string) => ({
      place,
      workspace,
      workItem,
      workflow: "coding",
      operation: "implement",
    });
    const event = decodeDaemonEvent({
      _tag: "QueueChanged",
      emittedAtMillis: 0,
      queue: {
        queued: [queued(1, "acme", "3"), queued(2, "beta", "1"), queued(3, "acme", "2")],
      },
    });
    const board = applyDaemonEvent(initialBoard, event);

    expect(queuedItems(board, null).map(({ item }) => item.workItem)).toEqual(["3", "1", "2"]);
    expect(
      queuedItems(board, Schema.decodeUnknownSync(WorkspaceId)("acme")).map(({ item }) => [
        item.place,
        item.workItem,
      ]),
    ).toEqual([
      [1, "3"],
      [3, "2"],
    ]);
  });
});

const workflowWithOperation = (id: string, name: string): WorkflowRecord => {
  const document = Schema.decodeUnknownSync(WorkflowDocument)({
    name: id,
    workspaces: { _tag: "Every" },
    triggers: [],
    operations: [
      {
        id: "operation",
        name,
        instructionPackage: null,
        instruction: "",
        permissionProfile: "read-only",
        requires: [],
        model: { harness: null, model: null, options: [] },
        forEach: null,
        questions: [],
        transitions: [],
        hints: [],
      },
    ],
  });
  return {
    id: decodeWorkflowId(id),
    principal: Schema.decodeUnknownSync(PrincipalId)("person"),
    workingCopy: document,
    workingRevision: 1,
    publishedCopy: document,
    publishedRevision: 1,
    enabled: true,
    diagnostics: [],
    readiness: [],
  };
};

describe("operationNameOf", () => {
  it("names an Operation from the Run's own Workflow when two Workflows reuse its id", () => {
    const triage = workflowWithOperation("triage", "Triage Issue");
    const implement = workflowWithOperation("implement", "Implement Issue");
    const workflows = new Map([
      [triage.id, triage],
      [implement.id, implement],
    ]);

    expect(operationNameOf(workflows, { workflow: implement.id, operation: "operation" })).toBe(
      "Implement Issue",
    );
    expect(operationNameOf(workflows, { operation: "operation" })).toBe("operation");
  });
});
