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

  it("adds each Hook without changing existing Hook state", () => {
    const existing = `[hooks.state."/repo/.codex/hooks.json:pre_tool_use:0:0"]
enabled = false
trusted_hash = "sha256:existing"
`;
    const entries = [
      { key: "/repo/.codex/hooks.json:pre_tool_use:0:0", hash: "sha256:updated" },
      { key: "/repo/.codex/hooks.json:post_tool_use:0:0", hash: "sha256:added" },
    ];

    assert.strictEqual(
      upsertCodexHookTrust(existing, entries),
      `[hooks.state."/repo/.codex/hooks.json:pre_tool_use:0:0"]
enabled = false
trusted_hash = "sha256:updated"

[hooks.state."/repo/.codex/hooks.json:post_tool_use:0:0"]
trusted_hash = "sha256:added"
`,
    );
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

  it("skips Hook shapes Codex does not trust", () => {
    const entries = codexHookTrustEntries(
      hooksPath,
      JSON.stringify({
        hooks: {
          PostToolUse: [
            {
              matcher: "[",
              hooks: [{ type: "command", command: "echo invalid matcher" }],
            },
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
