import { WorkspaceConfig } from "@clanker-forge/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type { Credential, CredentialStoreService } from "./credential-store";
import { credentialAccountFor } from "./linear/account";
import { make } from "./mcp-skill";

const config = (over: Partial<typeof WorkspaceConfig.Encoded>) =>
  Schema.decodeSync(WorkspaceConfig)({
    name: "lin",
    checkoutPath: "/repos/lin",
    issueTracker: {
      type: "linear",
      team: "ENG",
      oauth: { clientId: "cid", clientSecretEnv: "LINEAR_CLIENT_SECRET" },
    },
    harness: { preferred: "cursor" },
    ...over,
  });

const readonlySkill = {
  name: "linear",
  endpoint: "https://mcp.linear.app/mcp/readonly",
  auth: { type: "credential-store" as const },
};

const minted: Credential = {
  source: "client-credentials",
  token: Redacted.make("minted-token"),
  identity: null,
};

const storeStub = (calls: Ref.Ref<ReadonlyArray<string>>): CredentialStoreService => ({
  bearerToken: (account) => Ref.update(calls, (xs) => [...xs, account.key]).pipe(Effect.map(() => minted)),
  persist: () => Effect.void,
  invalidate: () => Effect.void,
});

describe("credentialAccountFor", () => {
  it("derives the Linear account from a Linear workspace, borrowing its client credentials", () => {
    const account = credentialAccountFor(config({ issueTracker: { type: "linear", team: "ENG" } }));
    assert.strictEqual(account?.issueTracker, "linear");
    assert.strictEqual(account?.key, "ENG");
    assert.strictEqual(account?.tokenEnv, "LINEAR_API_KEY");
  });

  it("returns null for a non-Linear workspace", () => {
    const account = credentialAccountFor(config({ issueTracker: { type: "github", repo: "owner/repo" } }));
    assert.isNull(account);
  });
});

describe("McpSkillAssembler.assemble", () => {
  it.effect("leaves a public skill unauthenticated and never touches the credential store", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<string>>([]);
      const assembler = make(storeStub(calls), credentialAccountFor);
      const resolved = yield* assembler.assemble(
        config({ mcpSkills: [{ name: "linear", endpoint: "https://mcp.linear.app/mcp" }] }),
      );
      assert.deepStrictEqual(
        [...resolved],
        [{ name: "linear", endpoint: "https://mcp.linear.app/mcp", bearer: null }],
      );
      assert.deepStrictEqual(yield* Ref.get(calls), []);
    }),
  );

  it.effect("resolves a credential-store bearer for an authed skill", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<string>>([]);
      const assembler = make(storeStub(calls), credentialAccountFor);
      const [resolved] = yield* assembler.assemble(config({ mcpSkills: [readonlySkill] }));
      assert.strictEqual(resolved?.endpoint, "https://mcp.linear.app/mcp/readonly");
      assert.strictEqual(resolved?.bearer ? Redacted.value(resolved.bearer) : null, "minted-token");
      assert.deepStrictEqual(yield* Ref.get(calls), ["ENG"]);
    }),
  );

  it.effect("fails when an authed skill has no credential account to source from", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<string>>([]);
      const assembler = make(storeStub(calls), () => null);
      const error = yield* Effect.flip(assembler.assemble(config({ mcpSkills: [readonlySkill] })));
      assert.strictEqual(error._tag, "CredentialError");
      assert.include(error.message, "no credential account");
    }),
  );
});
