import { HarnessName, RunPlan, SessionId } from "@cogwork/contracts";
import { ContextAssembler, CredentialStore, type Harness, SessionStore } from "@cogwork/engine";
import type { AcpJsonRpcStream } from "@tanstack/ai-acp";
import { memoryPersistence } from "@tanstack/ai-persistence";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

export type AcpMessage = AcpJsonRpcStream extends { readable: ReadableStream<infer Message> }
  ? Message
  : never;

export const cursorName = Schema.decodeSync(HarnessName)("cursor");
export const freshSessionId = Schema.decodeSync(SessionId)("sess-cursor-fresh");
export const resumedSessionId = Schema.decodeSync(SessionId)("sess-cursor-resume");

export const decodeObservation = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      prompt: Schema.String,
      model: Schema.String,
      mcp: Schema.Array(
        Schema.Struct({
          name: Schema.String,
          url: Schema.String,
          authenticated: Schema.Boolean,
        }),
      ),
      cursorConfigDir: Schema.NullOr(Schema.String),
      windowsEnvironment: Schema.Struct({
        USERPROFILE: Schema.NullOr(Schema.String),
        HOMEDRIVE: Schema.NullOr(Schema.String),
        HOMEPATH: Schema.NullOr(Schema.String),
        APPDATA: Schema.NullOr(Schema.String),
        SYSTEMROOT: Schema.NullOr(Schema.String),
        PATHEXT: Schema.NullOr(Schema.String),
        COMSPEC: Schema.NullOr(Schema.String),
      }),
      networkEnvironment: Schema.Struct({
        HTTP_PROXY: Schema.NullOr(Schema.String),
        HTTPS_PROXY: Schema.NullOr(Schema.String),
        NO_PROXY: Schema.NullOr(Schema.String),
        NODE_USE_ENV_PROXY: Schema.NullOr(Schema.String),
        NODE_EXTRA_CA_CERTS: Schema.NullOr(Schema.String),
      }),
      hasCursorApiKey: Schema.Boolean,
    }),
  ),
);

export const decodePermissionOutcome = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ outcome: Schema.String, optionId: Schema.String })),
);

const restoreEnvironment = (name: string, value: string | undefined) =>
  value === undefined ? Reflect.deleteProperty(process.env, name) : Reflect.set(process.env, name, value);

export const cursorEnvironmentProbe = {
  CURSOR_CONFIG_DIR: "/tmp/cogwork-cursor-config",
  CURSOR_API_KEY: "inherited-cursor-key",
  USERPROFILE: "C:\\Users\\cogwork",
  HOMEDRIVE: "C:",
  HOMEPATH: "\\Users\\cogwork",
  APPDATA: "C:\\Users\\cogwork\\AppData\\Roaming",
  SYSTEMROOT: "C:\\Windows",
  PATHEXT: ".COM;.EXE;.BAT;.CMD",
  COMSPEC: "C:\\Windows\\System32\\cmd.exe",
  HTTP_PROXY: "http://proxy.example.test:8080",
  HTTPS_PROXY: "https://proxy.example.test:8443",
  NO_PROXY: "localhost,127.0.0.1,.example.test",
  NODE_USE_ENV_PROXY: "1",
  NODE_EXTRA_CA_CERTS: "/tmp/cogwork-enterprise-ca.pem",
};

export const cursorWindowsEnvironmentProbe = {
  USERPROFILE: cursorEnvironmentProbe.USERPROFILE,
  HOMEDRIVE: cursorEnvironmentProbe.HOMEDRIVE,
  HOMEPATH: cursorEnvironmentProbe.HOMEPATH,
  APPDATA: cursorEnvironmentProbe.APPDATA,
  SYSTEMROOT: cursorEnvironmentProbe.SYSTEMROOT,
  PATHEXT: cursorEnvironmentProbe.PATHEXT,
  COMSPEC: cursorEnvironmentProbe.COMSPEC,
};

export const cursorNetworkEnvironmentProbe = {
  HTTP_PROXY: cursorEnvironmentProbe.HTTP_PROXY,
  HTTPS_PROXY: cursorEnvironmentProbe.HTTPS_PROXY,
  NO_PROXY: cursorEnvironmentProbe.NO_PROXY,
  NODE_USE_ENV_PROXY: cursorEnvironmentProbe.NODE_USE_ENV_PROXY,
  NODE_EXTRA_CA_CERTS: cursorEnvironmentProbe.NODE_EXTRA_CA_CERTS,
};

export const withCursorEnvironment = <Value, Error, Requirements>(
  effect: Effect.Effect<Value, Error, Requirements>,
) =>
  Effect.acquireUseRelease(
    Effect.sync(() =>
      Object.fromEntries(
        Object.keys(cursorEnvironmentProbe).map((name) => [name, Reflect.get(process.env, name)]),
      ),
    ),
    () => Effect.sync(() => Object.assign(process.env, cursorEnvironmentProbe)).pipe(Effect.andThen(effect)),
    (original) =>
      Effect.sync(() => Object.entries(original).map(([name, value]) => restoreEnvironment(name, value))),
  );

export const sessionStore: SessionStore.SessionStoreService = {
  persistence: memoryPersistence(),
  resumeHandle: () => Effect.succeed(null),
  mint: () => Effect.die(new Error("unexpected mint")),
};

const unexpected = () => Effect.die(new Error("unexpected service access"));

const harnessServices = {
  sessionStore,
  contextAssembler: { assemble: unexpected, cleanup: unexpected },
  credentialStore: {
    bearerToken: unexpected,
    resolveSource: unexpected,
    persist: unexpected,
    invalidate: unexpected,
    providerKey: unexpected,
    persistProviderKey: unexpected,
    configureConnection: unexpected,
    removeConnection: unexpected,
  },
  fileSystem: FileSystem.makeNoop({
    access: () => Effect.void,
    stat: () => Effect.succeed({ type: "Directory" } as FileSystem.File.Info),
  }),
};

export const harnessRunnerLayer = Layer.mergeAll(
  Layer.succeed(SessionStore.SessionStore, harnessServices.sessionStore),
  Layer.succeed(ContextAssembler.ContextAssembler, harnessServices.contextAssembler),
  Layer.succeed(CredentialStore.CredentialStore, harnessServices.credentialStore),
  Layer.succeed(FileSystem.FileSystem, harnessServices.fileSystem),
  Path.layer,
  FetchHttpClient.layer,
);

export const request = (checkoutPath: string, operation = "operate") => {
  const profile = "read-only" as const;
  return {
    plan: Schema.decodeSync(RunPlan)({
      id: "run-cursor-test",
      operation,
      harness: {
        name: cursorName,
        model: "auto",
        options: {},
        profile,
      },
      instructions: [],
      operatingInstructions: {
        name: `${operation}-agent`,
        path: `/operating-instructions/${operation}-agent`,
        resources: [],
      },
      tools: [],
      skills: [],
      mcp: [],
      subagents: [],
      hooks: [],
      middleware: ["sandbox"],
      structuredOutput: { type: "object" },
      connections: [],
      messages: [{ role: "user", content: "triage the issue" }],
      workContext: {
        reference: { workItem: "#1", url: null },
        prose: { body: "", comments: [] },
        facts: { assignees: [], openBlockers: 0, claim: null, priority: "medium" },
        observation: { generation: 1, observedAtMillis: 1 },
      },
      sandbox: {
        workspace: checkoutPath,
        policy: profile,
        commands: { allow: [], deny: [] },
        connections: [],
      },
      persistence: { sessionKind: "opaque-handle" },
      provenance: {
        resolution: [],
        stamps: [],
        projectedNames: [],
        projection: [],
        observation: { generation: 1, observedAtMillis: 1 },
      },
    }),
    session: freshSessionId,
    mcpCredentials: new Map(),
  } satisfies Harness.HarnessRequest;
};

export const fakeCursorAgent = new URL("./fixtures/fake-cursor-agent.mjs", import.meta.url).pathname;
