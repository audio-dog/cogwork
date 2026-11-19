import { RunPlan } from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import { getSandbox, getWorkspaceProjection } from "@tanstack/ai-sandbox";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { type ExternalHarnessDescriptor, externalHarnessRunner } from "./external-harness-runtime";
import {
  type ControlledAdapter,
  ControlledProbe,
  descriptor,
  freshSession,
  harnessRunnerLayer,
  hostAuthentication,
  makeHarness,
  request,
  runtimeCapabilities,
  terminalEvents,
} from "./external-harness-runtime-fixtures";
import { mcpBearerEnvironmentName } from "./external-harness-runtime-workspace";
import { make } from "./harness";

describe("external Harness runtime MCP", { timeout: 30_000 }, () => {
  it.layer(harnessRunnerLayer)((it) => {
    it.effect("projects public and authenticated MCP servers with collision-safe live secrets per Run", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const checkout = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-harness-workspace-" });
        const probe = new ControlledProbe();
        const observations: Array<{
          readonly names: ReadonlyArray<string>;
          readonly publicHasAuthorization: boolean;
          readonly liveBearers: ReadonlyArray<string>;
        }> = [];
        probe.inspect = (options) => {
          const capabilities = runtimeCapabilities(options);
          const sandbox = getSandbox(capabilities);
          const projection = getWorkspaceProjection(capabilities);
          const servers = projection.skills.filter((skill) => skill.kind === "mcp");
          const publicServer = servers.find(({ name }) => name === "public.mcp");
          const readBearer = (name: string) => {
            const authorization = servers.find((server) => server.name === name)?.config.headers
              ?.Authorization;
            if (
              typeof authorization !== "object" ||
              authorization === null ||
              !("__bearerRef" in authorization)
            ) {
              return Promise.reject(new Error(`authenticated MCP server ${name} has no bearer SecretRef`));
            }
            return sandbox.process
              .exec(
                `node -e 'process.stdout.write(process.env[process.argv[1]] ?? "")' '${authorization.__bearerRef.__secretName}'`,
              )
              .then(({ stdout }) => stdout);
          };
          return Promise.all([readBearer("linear.api"), readBearer("linear-api")]).then((liveBearers) => {
            observations.push({
              names: servers.map(({ name }) => name),
              publicHasAuthorization: publicServer?.config.headers?.Authorization !== undefined,
              liveBearers,
            });
          });
        };
        const plan = RunPlan.make({
          ...request,
          sandbox: { ...request.sandbox, workspace: checkout },
          mcp: [
            {
              identity: "local:repo/mcp/public.mcp",
              name: "public.mcp",
              projectedName: "public.mcp",
              endpoint: "https://public.example.test/mcp",
              authenticated: false,
              unavailableReason: null,
            },
            {
              identity: "local:repo/mcp/linear.api",
              name: "linear.api",
              projectedName: "linear.api",
              endpoint: "https://dot.example.test/mcp",
              authenticated: true,
              unavailableReason: null,
            },
            {
              identity: "local:repo/mcp/linear-api",
              name: "linear-api",
              projectedName: "linear-api",
              endpoint: "https://dash.example.test/mcp",
              authenticated: true,
              unavailableReason: null,
            },
          ],
        });
        const controlledDescriptor = descriptor(terminalEvents, probe);
        const runWith = (version: string) =>
          make([
            externalHarnessRunner(controlledDescriptor, {
              authentication: hostAuthentication,
            }),
          ])
            .run({
              plan,
              session: freshSession,
              mcpCredentials: new Map([
                ["local:repo/mcp/linear.api", Redacted.make(`${version}-dot-bearer`)],
                ["local:repo/mcp/linear-api", Redacted.make(`${version}-dash-bearer`)],
              ]),
            })
            .pipe(Stream.runCollect);

        const bearerNames = ["linear.api", "linear-api"].map(mcpBearerEnvironmentName);
        yield* Effect.acquireUseRelease(
          Effect.sync(() => {
            const original = Object.fromEntries(
              bearerNames.map((environmentName) => [
                environmentName,
                Reflect.get(process.env, environmentName),
              ]),
            );
            Object.assign(
              process.env,
              Object.fromEntries(bearerNames.map((environmentName) => [environmentName, "host-bearer"])),
            );
            return original;
          }),
          () => Effect.forEach(["first", "rotated"], runWith, { discard: true }),
          (original) =>
            Effect.sync(() =>
              Object.entries(original).map(([environmentName, value]) =>
                value === undefined
                  ? Reflect.deleteProperty(process.env, environmentName)
                  : Reflect.set(process.env, environmentName, value),
              ),
            ),
        );
        assert.deepStrictEqual(observations, [
          {
            names: ["public.mcp", "linear.api", "linear-api"],
            publicHasAuthorization: false,
            liveBearers: ["first-dot-bearer", "first-dash-bearer"],
          },
          {
            names: ["public.mcp", "linear.api", "linear-api"],
            publicHasAuthorization: false,
            liveBearers: ["rotated-dot-bearer", "rotated-dash-bearer"],
          },
        ]);
      }),
    );

    it.effect("hands native MCP a latched Sandbox projection marker", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const checkout = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-native-mcp-" });
        yield* fs.writeFileString(`${checkout}/.git`, "gitdir: /elsewhere\n");
        const probe = new ControlledProbe();
        probe.inspect = (options) => {
          const capabilities = runtimeCapabilities(options);
          const sandbox = getSandbox(capabilities);
          const projection = getWorkspaceProjection(capabilities);
          return Promise.all([
            sandbox.fs.exists(projection.markerPath),
            sandbox.fs.exists(".git"),
            sandbox.fs.read("../outside").then(
              () => false,
              (error) =>
                error instanceof Error &&
                error.message.includes('path "../outside" resolves outside the sandbox root'),
            ),
            sandbox.fs.exists("/workspace/.git"),
          ]).then(([markerExists, relativeMarkerExists, traversalEscapeRejected, virtualMarkerExists]) => {
            assert.strictEqual(projection.root, "/workspace");
            assert.strictEqual(projection.skills.length, 0);
            assert.isTrue(markerExists);
            assert.isTrue(relativeMarkerExists);
            assert.isTrue(traversalEscapeRejected);
            assert.isTrue(virtualMarkerExists);
            return sandbox.fs.write(projection.markerPath, "gitdir: /elsewhere\n");
          });
        };
        const base = descriptor(terminalEvents, probe);
        const nativeDescriptor: ExternalHarnessDescriptor<ControlledAdapter> = {
          ...base,
          transport: { instructionProjection: "system-prompt", mcpProjection: "native" },
        };
        const plan = RunPlan.make({
          ...request,
          sandbox: { ...request.sandbox, workspace: checkout },
          mcp: [
            {
              identity: "local:repo/mcp/linear.api",
              name: "linear.api",
              projectedName: "linear__api__native",
              endpoint: "https://dot.example.test/mcp",
              authenticated: true,
              unavailableReason: null,
            },
          ],
        });

        const harness = make([
          externalHarnessRunner(nativeDescriptor, {
            authentication: hostAuthentication,
          }),
        ]);
        yield* harness
          .run({
            plan,
            session: freshSession,
            mcpCredentials: new Map([["local:repo/mcp/linear.api", Redacted.make("native-bearer")]]),
          })
          .pipe(Stream.runDrain);

        assert.deepStrictEqual(
          probe.resolved[0]?.request.mcp.map(({ name, endpoint, bearer }) => ({
            name,
            endpoint,
            bearer: bearer === null ? null : Redacted.value(bearer),
          })),
          [
            {
              name: "linear__api__native",
              endpoint: "https://dot.example.test/mcp",
              bearer: "native-bearer",
            },
          ],
        );
        assert.deepStrictEqual(yield* fs.readDirectory(checkout), [".git"]);
      }),
    );

    it.effect("rejects an authenticated MCP server without a live credential before launch", () =>
      Effect.gen(function* () {
        const probe = new ControlledProbe();
        const harness = makeHarness(descriptor(terminalEvents, probe));
        const plan = RunPlan.make({
          ...request,
          mcp: [
            {
              identity: "local:repo/mcp/required-auth",
              name: "required-auth",
              projectedName: "required-auth",
              endpoint: "https://required.example.test/mcp",
              authenticated: true,
              unavailableReason: null,
            },
          ],
        });

        const error = yield* harness
          .run({ plan, session: freshSession, mcpCredentials: new Map() })
          .pipe(Stream.runDrain, Effect.flip);

        assert.strictEqual(error.reason, "credential");
        assert.strictEqual(error.retryable, false);
        assert.include(error.message, "required-auth");
        assert.deepStrictEqual(probe.resolved, []);
      }),
    );
  });
});
