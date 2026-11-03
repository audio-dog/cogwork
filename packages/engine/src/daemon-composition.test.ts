import {
  connectionIdOf,
  DaemonRpcs,
  HarnessName,
  IssueTrackerType,
  keyOf,
  LineageId,
  WorkflowDocument,
  WorkItemId,
  WorkspaceId,
} from "@cogwork/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import * as RpcServer from "effect/unstable/rpc/RpcServer";
import * as Socket from "effect/unstable/socket/Socket";
import * as SocketServer from "effect/unstable/socket/SocketServer";
import { vi } from "vitest";
import * as ContextAssembler from "./context-assembler";
import { Coordination } from "./coordination";
import * as CredentialStore from "./credential-store";
import * as Daemon from "./daemon";
import { Git, type GitService } from "./git";
import { fullHarnessExecution, type HarnessRunner } from "./harness";
import { PerformanceHealthSource } from "./performance-health-source";
import * as RunLedger from "./run-ledger";
import type { TriggerAdmission } from "./trigger-observation";
import { WorkflowRun } from "./workflow-run";
import { WorktreeManager } from "./worktree";

const harnessName = HarnessName.make("scripted");
const githubType = Schema.decodeSync(IssueTrackerType)("github");
const structuredOutput = (workspace: string) => ({
  summary: "Ready for implementation",
  stuck: false,
  answers: { role: "ready-for-agent" },
  inputs: { comment: "Ready for implementation.", hand_off: "" },
  workspace,
});

const runner = (workspace: Ref.Ref<string>): HarnessRunner => ({
  name: harnessName,
  sessionKind: "owned-transcript",
  projectedMembers: [],
  planMiddleware: ["sandbox", "persistence", "instruction-context"],
  execution: fullHarnessExecution,
  capabilities: {
    authenticationModes: ["host"],
    session: { affinity: "portable", fork: false, humanAttach: false },
    structuredOutput: "native",
    policyFidelity: "exact",
    fileEventFidelity: "absent",
    usageQuality: "none",
    readinessDiagnostics: false,
    journal: false,
    takeover: false,
  },
  authentication: { mode: "host", reference: "test" },
  catalog: { models: [] },
  readiness: () =>
    Effect.succeed({
      operational: { status: "ready", retryable: false, diagnostic: "ready" },
      installation: { status: "installed", version: "1" },
      compatibility: { status: "compatible", requirement: null },
      authentication: { mode: "host", status: "available", diagnostic: "ready" },
      diagnostics: [],
    }),
  preflight: () => Effect.void,
  run: () =>
    Stream.fromEffect(
      Ref.get(workspace).pipe(
        Effect.map((selected) => {
          const object = structuredOutput(selected);
          return {
            type: "CUSTOM" as const,
            name: "structured-output.complete" as const,
            value: { object, raw: JSON.stringify(object) },
          };
        }),
      ),
    ),
});

const worktreeLayer = Layer.succeed(WorktreeManager, {
  withRunOwnershipLock: (effect) => effect,
  tryWithMaintenanceLock: Effect.asSome,
  ensure: () => Effect.die("unused"),
  pullRequestReadiness: () => Effect.die("unused"),
  pushBranch: () => Effect.die("unused"),
  pushBranchIfAhead: () => Effect.die("unused"),
  list: () => Effect.succeed([]),
  remove: () => Effect.void,
  reconcile: () => Effect.succeed({ tornDown: [], reaped: [] }),
});

const gitLayer = Layer.succeed(Git, {
  fetch: () => Effect.die("unused"),
  remoteBranchExists: () => Effect.die("unused"),
  addWorktree: () => Effect.die("unused"),
  removeWorktree: () => Effect.die("unused"),
  listWorktrees: () => Effect.die("unused"),
  fastForward: () => Effect.die("unused"),
  divergence: () => Effect.die("unused"),
  operationInProgress: () => Effect.die("unused"),
  rebase: () => Effect.die("unused"),
  remoteUrl: () => Effect.succeed("git@github.com:owner/repo.git"),
  blockPush: () => Effect.die("unused"),
  allowPush: () => Effect.die("unused"),
  pushBranch: () => Effect.die("unused"),
} satisfies GitService);

const credentialsLayer = Layer.succeed(CredentialStore.CredentialStore, {
  resolveSource: () =>
    Effect.succeed({ source: "stored-key", token: Redacted.make("token"), identity: null }),
  bearerToken: () =>
    Effect.succeed({
      source: "stored-key",
      token: Redacted.make("token"),
      identity: null,
    }),
  persist: () => Effect.void,
  invalidate: () => Effect.void,
  providerKey: () => Effect.die("unused"),
  persistProviderKey: () => Effect.die("unused"),
  configureConnection: () => Effect.void,
  removeConnection: () => Effect.void,
} satisfies CredentialStore.CredentialStoreService);

const contextAssemblerLayer = Layer.succeed(ContextAssembler.ContextAssembler, {
  assemble: () =>
    Effect.succeed({
      layers: [],
      operatingInstructionsName: "triage-agent",
      operatingInstructionsPath: "/skills",
      operatingInstructionResources: [],
      sources: [],
    }),
  cleanup: () => Effect.void,
});

const socketServerLayer = (socket: Socket.Socket) =>
  Layer.succeed(SocketServer.SocketServer, {
    address: { _tag: "UnixAddress", path: "memory" },
    run: (handler) => handler(socket).pipe(Effect.ignore, Effect.andThen(Effect.never)),
  });

const issueResponse = (labels: ReadonlyArray<string>) => ({
  node_id: "I_issue_1",
  number: 1,
  title: "Triage me",
  html_url: "https://github.com/owner/repo/issues/1",
  labels,
  assignees: [],
  body: "Please triage this issue.",
  state: "open",
  created_at: "2026-11-01T12:00:00Z",
});

const jsonResponse = (body: unknown = {}, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const makeFixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-daemon-composition-" });
  const checkoutPath = path.join(root, "repo");
  yield* fs.makeDirectory(checkoutPath);
  const labels = ["needs-triage"];
  const comments: Array<Record<string, unknown>> = [];
  const selectedWorkspace = yield* Ref.make("none");
  const fetchStub = vi.fn<typeof globalThis.fetch>((input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/user") {
      return Promise.resolve(jsonResponse({ login: "owner" }));
    }
    if (request.method === "POST" && url.pathname === "/graphql") {
      return Promise.resolve(
        jsonResponse({
          data: {
            repository: {
              pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
            },
          },
        }),
      );
    }
    if (request.method === "GET" && url.pathname.endsWith("/issues/1/comments")) {
      return Promise.resolve(jsonResponse(comments));
    }
    if (request.method === "POST" && url.pathname.endsWith("/issues/1/comments")) {
      return request.json().then((unknown) => {
        const payload = unknown as { readonly body: string };
        comments.push({
          id: 1,
          body: payload.body,
          created_at: "2026-11-01T12:01:00Z",
          author_association: "MEMBER",
          user: { login: "cogwork", type: "Bot" },
        });
        return jsonResponse({}, 201);
      });
    }
    if (request.method === "POST" && url.pathname.endsWith("/issues/1/labels")) {
      return request.json().then((unknown) => {
        const payload = unknown as { readonly labels: ReadonlyArray<string> };
        labels.push(...payload.labels);
        return jsonResponse(payload.labels.map((name) => ({ name })));
      });
    }
    if (request.method === "GET" && url.pathname.endsWith("/issues/1")) {
      return Promise.resolve(jsonResponse(issueResponse(labels)));
    }
    return Promise.resolve(jsonResponse([]));
  });
  vi.stubGlobal("fetch", fetchStub);
  const toServer = new TransformStream<Uint8Array, Uint8Array>();
  const toClient = new TransformStream<Uint8Array, Uint8Array>();
  const client = yield* Socket.fromTransformStream(
    Effect.succeed({ readable: toClient.readable, writable: toServer.writable }),
  );
  const server = yield* Socket.fromTransformStream(
    Effect.succeed({ readable: toServer.readable, writable: toClient.writable }),
  );
  const transport = RpcServer.layerProtocolSocketServer.pipe(Layer.provide(socketServerLayer(server)));
  const clientLayer = RpcClient.layerProtocolSocket().pipe(
    Layer.provide(Layer.succeed(Socket.Socket, client)),
    Layer.provide(Daemon.serializationLayer),
  );
  const serverLayer = Daemon.serverLayer({
    transport,
    credentials: credentialsLayer,
    contextAssembler: contextAssemblerLayer,
    runLedger: RunLedger.layerMemoryCore,
    controlStorePath: path.join(root, "control.db"),
    userAgentsDir: path.join(root, ".agents"),
    worktrees: worktreeLayer,
    harnessRunners: [runner(selectedWorkspace)],
    appVersion: "test",
    performanceEvidenceRoot: path.join(root, "perf"),
    performanceHealth: Layer.succeed(PerformanceHealthSource, {
      snapshot: Effect.succeed({ sampledAtMillis: 0 }),
    }),
  }).pipe(Layer.provide(gitLayer));
  return { checkoutPath, fetchStub, selectedWorkspace, clientLayer, serverLayer };
});

class Fixture extends Context.Service<Fixture, Effect.Success<typeof makeFixture>>()(
  "@cogwork/engine/daemon-composition.test/Fixture",
) {
  static readonly layer = Layer.effect(Fixture, makeFixture);
}

const testLayer = Layer.unwrap(
  Effect.map(Fixture, ({ clientLayer, serverLayer }) =>
    Layer.merge(serverLayer, clientLayer).pipe(Layer.provide(NodeServices.layer)),
  ),
).pipe(Layer.provideMerge(Fixture.layer), Layer.provide(NodeServices.layer));

describe("daemon composition", () => {
  it.effect("creates, publishes, and enables the coding template before triaging through the daemon", () =>
    Effect.gen(function* () {
      const fixture = yield* Fixture;
      const rpc = yield* RpcClient.make(DaemonRpcs);
      assert.deepStrictEqual((yield* rpc.ListWorkflows()).workflows, []);
      yield* rpc.EstablishConnection({
        establishment: { system: "github", source: { _tag: "Stored" } },
      });
      const registration = yield* rpc.RegisterWorkspace({
        registration: {
          name: WorkspaceId.make("github"),
          checkoutPath: fixture.checkoutPath,
          issueTracker: { type: githubType, connectionId: connectionIdOf("github", "owner") },
          linearHistory: false,
        },
      });
      assert.strictEqual(registration._tag, "Registered");
      if (registration._tag !== "Registered") return;
      yield* Ref.set(fixture.selectedWorkspace, registration.name);
      const template = (yield* rpc.GetWorkflowTemplates()).find(({ id }) => id === "github-coding-pipeline");
      if (!template) return assert.fail("GitHub coding template is missing");
      const document = WorkflowDocument.make({
        ...template.document,
        operations: template.document.operations.map((operation) => ({
          ...operation,
          model: { ...operation.model, harness: harnessName },
        })),
      });
      const created = yield* rpc.CreateWorkflow({ document });
      const published = yield* rpc.PublishWorkflow({ id: created.id, revision: created.workingRevision });
      yield* rpc.SwitchWorkflow({ id: published.id, enabled: true });
      const selected = document.triggers.find(({ id }) => id === "needs-triage");
      if (!selected) return assert.fail("needs-triage Trigger is missing");
      const workspace = registration.name;
      const issue = { _tag: "Issue", workspace, id: WorkItemId.make("#1") } as const;
      const revision = "label:needs-triage:1";
      const admission = {
        event: {
          key: issue,
          revision,
          cause: { _tag: "Unknown" },
          atMillis: 1,
          entry: selected.entry,
          workspace,
          parameters: selected.parameters,
        },
        subscription: {
          workflow: published.id,
          trigger: selected.id,
          operation: selected.start,
          entry: selected.entry,
          parameters: selected.parameters,
          workspaces: [workspace],
          catchUp: { since: 0 },
        },
        lineage: { root: LineageId.make(keyOf(issue)), parent: null, hop: 0 },
      } satisfies TriggerAdmission;
      yield* (yield* Coordination).observe(issue, revision, { _tag: "Unknown" });
      assert.strictEqual(yield* (yield* WorkflowRun).execute(admission), "completed");

      const labelWrite = fixture.fetchStub.mock.calls.some(([input, init]) => {
        const request = new Request(input, init);
        return request.method === "POST" && request.url.endsWith("/issues/1/labels");
      });
      assert.isTrue(labelWrite);
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );
});
