import { WorkflowNodeId, type WorkflowOperation } from "@cogwork/contracts";
import * as Schema from "effect/Schema";

const decodeNodeId = Schema.decodeUnknownSync(WorkflowNodeId);

export const newWorkflowOperation = (): WorkflowOperation => ({
  id: decodeNodeId(`operation-${crypto.randomUUID()}`),
  name: "New Operation",
  instructionPackage: null,
  instruction: "",
  permissionProfile: "full",
  requires: [],
  model: { harness: null, model: null, options: [] },
  forEach: null,
  questions: [],
  transitions: [],
  hints: [],
});
