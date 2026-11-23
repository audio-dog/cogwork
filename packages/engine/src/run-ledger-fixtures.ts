import {
  BranchName,
  HarnessName,
  RunId,
  RunPlan,
  type RunRecord,
  type Session,
  SessionId,
  WorkItemId,
  WorkspaceId,
} from "@cogwork/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as DaemonEventBus from "./daemon-event-bus";
import { layerMemory as memoryLedgerLayer, type RunLedgerService } from "./run-ledger";

export const layerMemory = memoryLedgerLayer.pipe(Layer.provide(DaemonEventBus.layer));

export const runId = Schema.decodeSync(RunId);
export const branchName = Schema.decodeSync(BranchName);
export const workspace = Schema.decodeSync(WorkspaceId)("gh");
export const otherWorkspace = Schema.decodeSync(WorkspaceId)("other");
export const workItem = Schema.decodeSync(WorkItemId)("#7");
export const bareWorkItem = Schema.decodeSync(WorkItemId)("7");
export const otherWorkItem = Schema.decodeSync(WorkItemId)("#8");
export const session = Schema.decodeSync(SessionId)("sess-abc");
export const laterSession = Schema.decodeSync(SessionId)("sess-later");

export const recordLoggedTransitions = Effect.fn("test.recordLoggedTransitions")(function* (
  ledger: RunLedgerService,
  id: RunId,
) {
  yield* ledger.acceptRun(record(id, 1000), runPlan(id));
  yield* ledger.appendEvent(id, {
    seq: 0,
    type: "RUN_STARTED",
    name: null,
    data: "{}",
    atMillis: 1001,
  });
  yield* ledger.updateRun(id, {
    status: "succeeded",
    usage: null,
    endedAtMillis: 2000,
  });
});
export const harness = Schema.decodeSync(HarnessName)("cursor");

export const runPlan = (id: string) =>
  Schema.decodeSync(RunPlan)({
    id: runId(id),
    operation: "triage",
    harness: { name: harness, model: null, options: {}, profile: "read-only" },
    instructions: [],
    operatingInstructions: {
      name: "triage-agent",
      path: "/operating-instructions/triage-agent",
      resources: [],
    },
    tools: [],
    skills: [],
    mcp: [],
    subagents: [],
    hooks: [],
    middleware: [],
    structuredOutput: null,
    connections: [],
    messages: [{ role: "user", content: "Triage #7" }],
    workContext: {
      reference: { workItem, url: "https://example.test/issues/7" },
      prose: { body: "", comments: [] },
      facts: {
        assignees: [],
        openBlockers: 0,
        claim: null,
        priority: "medium",
      },
      observation: { generation: 3, observedAtMillis: 1000 },
    },
    sandbox: { workspace: "/repo", policy: "read-only", commands: { allow: [], deny: [] }, connections: [] },
    persistence: { sessionKind: "opaque-handle" },
    provenance: {
      resolution: [],
      stamps: [],
      projectedNames: [],
      projection: [],
      observation: { generation: 3, observedAtMillis: 1000 },
    },
  });

export const record = (id: string, startedAtMillis: number, over: Partial<RunRecord> = {}): RunRecord => ({
  id: runId(id),
  workspace,
  workItem,
  operation: "triage",
  harness,
  branch: null,
  session: null,
  usage: null,
  status: "running",
  startedAtMillis,
  endedAtMillis: null,
  ...over,
});

export const sessionRecord = (over: Partial<Session> = {}): Session => ({
  kind: "opaque-handle",
  id: session,
  workspace,
  harness,
  createdAtMillis: 0,
  handle: "cursor-abc",
  ...over,
});
