import { DatabaseSync } from "node:sqlite";

import {
  BranchName,
  HarnessName,
  RunId,
  RunPlan,
  type RunRecord,
  type Session,
  SessionId,
  WorkflowId,
  WorkItemId,
  WorkspaceId,
} from "@cogwork/contracts";
import { bootControlStoreLayer } from "@cogwork/engine";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as MutableRef from "effect/MutableRef";
import * as Schema from "effect/Schema";

import { layer as ledgerLayer } from "./ledger";

export class TestStorePath extends Context.Service<TestStorePath, string>()(
  "@cogwork/cli/ledger-fixtures/TestStorePath",
) {}

export interface LedgerLogProbeService {
  readonly capture: (entry: unknown) => void;
  readonly entries: Effect.Effect<ReadonlyArray<unknown>>;
}

export class LedgerLogProbe extends Context.Service<LedgerLogProbe, LedgerLogProbeService>()(
  "@cogwork/cli/ledger-fixtures/LedgerLogProbe",
) {
  static readonly layer = Layer.sync(LedgerLogProbe, () => {
    const entries = MutableRef.make<ReadonlyArray<unknown>>([]);
    return {
      capture: (entry) => MutableRef.update(entries, (current) => [...current, entry]),
      entries: Effect.sync(() => MutableRef.get(entries)),
    };
  });
  static readonly captureLayer = Logger.layer([
    Effect.map(LedgerLogProbe, (probe) =>
      Logger.make<unknown, void>(({ message }) => probe.capture(message)),
    ),
  ]).pipe(Layer.provideMerge(LedgerLogProbe.layer));
}

export const bootedLedgerLayer = (storePath: string) =>
  ledgerLayer.pipe(Layer.provideMerge(bootControlStoreLayer(storePath, { busyTimeout: "25 millis" })));

export const runRow = (run: RunRecord) =>
  [
    run.id,
    run.workspace,
    run.workItem,
    run.operation,
    run.harness,
    run.branch,
    run.session,
    run.usage?.inputTokens ?? null,
    run.usage?.outputTokens ?? null,
    run.usage?.totalTokens ?? null,
    run.status,
    run.startedAtMillis,
    run.endedAtMillis,
  ] as const;

export const insertRunsBulk = (storePath: string, records: ReadonlyArray<RunRecord>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => new DatabaseSync(storePath)),
    (sqlite) =>
      Effect.sync(() => {
        sqlite.exec("BEGIN");
        const insert = sqlite.prepare(`
          INSERT INTO runs (
            id, workspace, work_item, operation, harness, branch, session,
            input_tokens, output_tokens, total_tokens, status, started_at, ended_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const run of records) {
          insert.run(...runRow(run));
        }
        sqlite.exec("COMMIT");
      }),
    (sqlite) => Effect.sync(() => sqlite.close()),
  );

export const runId = Schema.decodeSync(RunId);
export const branchName = Schema.decodeSync(BranchName);
export const workspace = Schema.decodeSync(WorkspaceId)("gh");
export const otherWorkspace = Schema.decodeSync(WorkspaceId)("other");
export const workItem = Schema.decodeSync(WorkItemId)("#7");
export const crashItem = Schema.decodeSync(WorkItemId)("#101");
export const resolveItem = Schema.decodeSync(WorkItemId)("#202");
export const bareResolveItem = Schema.decodeSync(WorkItemId)("202");
export const resolveOther = Schema.decodeSync(WorkItemId)("#303");
export const missingResolveItem = Schema.decodeSync(WorkItemId)("#404");
export const triageWorkflow = Schema.decodeSync(WorkflowId)("triage-workflow");
export const session = Schema.decodeSync(SessionId)("sess-abc");
export const replacementSession = Schema.decodeSync(SessionId)("sess-replaced");
export const midSession = Schema.decodeSync(SessionId)("sess-mid");
export const foldSession = Schema.decodeSync(SessionId)("sess-fold");
export const ownedSession = Schema.decodeSync(SessionId)("sess-owned");
export const harness = Schema.decodeSync(HarnessName)("cursor");

export const runPlan = (id: string, message = "Triage #7") =>
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
    messages: [{ role: "user", content: message }],
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

export const record = (
  id: string,
  startedAtMillis: number,
  overrides: Partial<RunRecord> = {},
): RunRecord => ({
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
  ...overrides,
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
