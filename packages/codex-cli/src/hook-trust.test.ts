import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import {
  codexHookTrustEntries,
  untrustedCodexHooks,
  upsertCodexHookTrust,
  writeCodexHookTrust,
} from "./hook-trust";

const hooksPath = "/Users/taylorsteele/sites/cogwork/.codex/hooks.json";
const hooksJson = JSON.stringify({
  description: "Repository hook config",
  hooks: {
    PostToolUse: [
      {
        matcher: "apply_patch|Edit|Write",
        hooks: [
          {
            type: "command",
            command: 'cd "$(git rev-parse --show-toplevel)" && node scripts/format-edited-files.mjs',
            timeout: 120,
            statusMessage: "Formatting edited files",
          },
        ],
      },
    ],
  },
});

describe("Codex Hook trust", () => {
  it("matches Codex's checksum and per-handler trust key", () => {
    assert.deepStrictEqual(codexHookTrustEntries(hooksPath, hooksJson), [
      {
        key: `${hooksPath}:post_tool_use:0:0`,
        hash: "sha256:8ced41e862df045c945dedd0bd206bf4bf7f440003c3462cf9fb048ff69c0dba",
      },
    ]);
  });

  it("matches Codex's ordinal object key order", () => {
    assert.deepStrictEqual(
      codexHookTrustEntries(
        "/repo/.codex/hooks.json",
        JSON.stringify({
          hooks: {
            PreToolUse: [
              {
                matcher: "(?i)^bash$",
                hooks: [
                  {
                    type: "mcp_tool",
                    server: "security",
                    tool: "scan",
                    input: { a: 1, B: 2, nested: { z: 1, A: 2 } },
                  },
                ],
              },
            ],
          },
        }),
      ),
      [
        {
          key: "/repo/.codex/hooks.json:pre_tool_use:0:0",
          hash: "sha256:3d83be8f7219f4699c4151ec1bfabd4f97402e2b2f1b3edea8a8eb3107f736c6",
        },
      ],
    );
  });

  it("matches Codex's UTF-8 object key order", () => {
    assert.deepStrictEqual(
      codexHookTrustEntries(
        "/repo/.codex/hooks.json",
        JSON.stringify({
          hooks: {
            PreToolUse: [
              {
                hooks: [
                  {
                    type: "mcp_tool",
                    server: "security",
                    tool: "scan",
                    input: { "\ue000": 1, "\u{10000}": 2 },
                  },
                ],
              },
            ],
          },
        }),
      ),
      [
        {
          key: "/repo/.codex/hooks.json:pre_tool_use:0:0",
          hash: "sha256:007ef96be38acb2271a9308752516c02f0f3a84afdc13cf4802b02416550a5bd",
        },
      ],
    );
  });

  it("adds each Hook without changing existing Hook state", () => {
    const existing = `[hooks.state."/repo/.codex/hooks.json:pre_tool_use:0:0"]
enabled = false
trusted_hash = "sha256:existing"
`;
    const entries = [
      { key: "/repo/.codex/hooks.json:pre_tool_use:0:0", hash: "sha256:updated" },
      { key: "/repo/.codex/hooks.json:post_tool_use:0:0", hash: "sha256:added" },
    ];

    const updated = upsertCodexHookTrust(existing, entries);

    assert.include(updated, "enabled = false");
    assert.include(updated, 'trusted_hash = "sha256:updated"');
    assert.include(updated, 'trusted_hash = "sha256:added"');
    assert.deepStrictEqual(untrustedCodexHooks(updated, entries), [entries[0]?.key]);
  });

  it("understands alternate TOML syntax without duplicating Hook state", () => {
    const key = "/repo/.codex/hooks.json:post_tool_use:0:0";
    const entry = { key, hash: "sha256:updated" };
    const existing = `[hooks.state.'${key}']\ntrusted_hash='sha256:old' # prior trust\n`;
    const updated = upsertCodexHookTrust(existing, [entry]);

    assert.deepStrictEqual(untrustedCodexHooks(updated, [entry]), []);
    assert.strictEqual(updated.match(/post_tool_use:0:0/g)?.length, 1);
  });

  it.effect("writes repository Hook trust into the Codex user config", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "codex-hook-trust-" });
      const sourcePath = `${root}/repo/.codex/hooks.json`;
      const configPath = `${root}/codex/config.toml`;
      yield* fs.makeDirectory(`${root}/repo/.codex`, { recursive: true });
      yield* fs.makeDirectory(`${root}/codex`, { recursive: true });
      yield* fs.writeFileString(sourcePath, hooksJson);
      yield* fs.writeFileString(
        configPath,
        `[hooks.state."/other/hook.json:pre_tool_use:0:0"]\ntrusted_hash = "sha256:existing"\n`,
      );

      const entries = yield* writeCodexHookTrust(sourcePath, configPath);
      const config = yield* fs.readFileString(configPath);

      assert.include(config, "sha256:existing");
      assert.deepStrictEqual(untrustedCodexHooks(config, entries), []);
    }).pipe(Effect.scoped, Effect.provide(Layer.merge(NodeFileSystem.layer, Path.layer))),
  );

  it.effect("serializes concurrent trust writes without losing entries", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "codex-hook-trust-concurrent-" });
      const firstPath = `${root}/first/hooks.json`;
      const secondPath = `${root}/second/hooks.json`;
      const configPath = `${root}/codex/config.toml`;
      yield* fs.makeDirectory(`${root}/first`, { recursive: true });
      yield* fs.makeDirectory(`${root}/second`, { recursive: true });
      yield* fs.writeFileString(firstPath, hooksJson);
      yield* fs.writeFileString(secondPath, hooksJson);

      const [first, second] = yield* Effect.all(
        [writeCodexHookTrust(firstPath, configPath), writeCodexHookTrust(secondPath, configPath)],
        { concurrency: "unbounded" },
      );
      const config = yield* fs.readFileString(configPath);

      assert.deepStrictEqual(untrustedCodexHooks(config, [...first, ...second]), []);
    }).pipe(Effect.scoped, Effect.provide(Layer.merge(NodeFileSystem.layer, Path.layer))),
  );

  it("names a missing Hook entry", () => {
    const entries = codexHookTrustEntries(hooksPath, hooksJson);

    assert.deepStrictEqual(untrustedCodexHooks("", entries), [entries[0]?.key]);
  });

  it("names a stale Hook entry", () => {
    const entries = codexHookTrustEntries(hooksPath, hooksJson);
    const stale = upsertCodexHookTrust("", [{ key: entries[0]?.key ?? "", hash: "sha256:stale" }]);

    assert.deepStrictEqual(untrustedCodexHooks(stale, entries), [entries[0]?.key]);
  });

  it("accepts an all-trusted Hook set", () => {
    const entries = codexHookTrustEntries(hooksPath, hooksJson);

    assert.deepStrictEqual(untrustedCodexHooks(upsertCodexHookTrust("", entries), entries), []);
  });

  it("names a disabled Hook even when its checksum is current", () => {
    const entries = codexHookTrustEntries(hooksPath, hooksJson);
    const disabled = upsertCodexHookTrust(`[hooks.state."${entries[0]?.key}"]\nenabled = false\n`, entries);
    assert.deepStrictEqual(untrustedCodexHooks(disabled, entries), [entries[0]?.key]);
  });

  it("fails closed on matcher syntax rejected by Codex", () => {
    assert.throws(() =>
      codexHookTrustEntries(
        hooksPath,
        JSON.stringify({
          hooks: {
            PreToolUse: [{ matcher: "(?=bash)", hooks: [{ type: "command", command: "scan" }] }],
          },
        }),
      ),
    );
  });

  it("accepts Codex's match-all matcher", () => {
    const entries = codexHookTrustEntries(
      hooksPath,
      JSON.stringify({
        hooks: {
          PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "scan" }] }],
        },
      }),
    );

    assert.lengthOf(entries, 1);
  });

  it("ignores matchers for matcherless events", () => {
    const entries = codexHookTrustEntries(
      hooksPath,
      JSON.stringify({
        hooks: {
          Stop: [{ matcher: "(?=ignored)", hooks: [{ type: "command", command: "scan" }] }],
        },
      }),
    );

    assert.lengthOf(entries, 1);
  });

  it("rejects unknown top-level Hook fields", () => {
    assert.throws(() => codexHookTrustEntries(hooksPath, JSON.stringify({ hooks: {}, bogus: true })));
  });

  it("rejects duplicate Windows command aliases", () => {
    assert.throws(() =>
      codexHookTrustEntries(
        hooksPath,
        JSON.stringify({
          hooks: {
            PreToolUse: [
              {
                hooks: [
                  {
                    type: "command",
                    command: "scan",
                    commandWindows: "scan.cmd",
                    command_windows: "scan.bat",
                  },
                ],
              },
            ],
          },
        }),
      ),
    );
  });

  it("fails closed on MCP input Codex cannot hash as TOML", () => {
    assert.throws(() =>
      codexHookTrustEntries(
        hooksPath,
        JSON.stringify({
          hooks: {
            PreToolUse: [
              {
                hooks: [{ type: "mcp_tool", server: "security", tool: "scan", input: { path: null } }],
              },
            ],
          },
        }),
      ),
    );
  });

  it("skips unsupported Hook shapes", () => {
    const entries = codexHookTrustEntries(
      hooksPath,
      JSON.stringify({
        hooks: {
          PostToolUse: [
            {
              hooks: [{ type: "prompt" }],
            },
            {
              hooks: [{ type: "agent" }],
            },
            {
              hooks: [{ type: "command", command: "   " }],
            },
          ],
          SessionEnd: [
            {
              hooks: [{ type: "mcp_tool", server: "security", tool: "scan" }],
            },
          ],
        },
      }),
    );

    assert.deepStrictEqual(entries, []);
  });
});
