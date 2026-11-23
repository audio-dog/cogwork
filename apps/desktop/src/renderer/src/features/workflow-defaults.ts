import { type WorkflowDocument, WorkflowNodeId, type WorkflowOperation } from "@cogwork/contracts";
import * as Schema from "effect/Schema";

const decodeNodeId = Schema.decodeUnknownSync(WorkflowNodeId);

/** Operation, Trigger, and Question ids share one namespace across the document. */
export const documentNodeIds = (document: WorkflowDocument) => [
  ...document.triggers.map(({ id }) => id),
  ...document.operations.flatMap((operation) => [operation.id, ...operation.questions.map(({ id }) => id)]),
];

export const freshNodeId = (prefix: string, taken: ReadonlyArray<string>) =>
  decodeNodeId(
    Array.from({ length: taken.length + 1 }, (_, index) =>
      index === 0 ? prefix : `${prefix}-${index + 1}`,
    ).find((id) => !taken.includes(id)) ?? `${prefix}-${taken.length + 1}`,
  );

export const yesOrNoQuestion = (id: WorkflowNodeId) => ({
  id,
  text: "What happened?",
  choices: [
    { id: decodeNodeId("yes"), name: "yes" },
    { id: decodeNodeId("no"), name: "no" },
  ],
});

export const newWorkflowOperation = (taken: ReadonlyArray<string>): WorkflowOperation => {
  const id = freshNodeId("operation", taken);
  return {
    id,
    name: "New Operation",
    instructionPackage: null,
    instruction: "",
    permissionProfile: "read-only",
    commands: { allow: [], deny: [] },
    connections: [],
    requires: [],
    model: { harness: null, model: null, options: [] },
    forEach: null,
    questions: [yesOrNoQuestion(freshNodeId("outcome", [...taken, id]))],
    transitions: [],
    hints: [],
  };
};
