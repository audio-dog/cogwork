import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

export interface CredentialAccount {
  readonly key: string;
  readonly tokenEnv: string;
}

export class CredentialError extends Schema.TaggedErrorClass<CredentialError>()("CredentialError", {
  account: Schema.String,
  message: Schema.String,
}) {}

export interface CredentialStoreService {
  readonly bearerToken: (
    account: CredentialAccount,
  ) => Effect.Effect<Redacted.Redacted<string>, CredentialError>;
}

export class CredentialStore extends Context.Service<CredentialStore, CredentialStoreService>()(
  "@clanker-forge/engine/CredentialStore",
) {}

const envToken = (account: CredentialAccount) =>
  Config.redacted(account.tokenEnv).pipe(Effect.orElseSucceed(() => Redacted.make("")));

const envStore: CredentialStoreService = {
  bearerToken: Effect.fn("CredentialStore.bearerToken")(function* (account: CredentialAccount) {
    const configured = yield* envToken(account);
    const token = Redacted.value(configured).trim();
    if (token === "") {
      return yield* new CredentialError({
        account: account.key,
        message: `no credential for ${account.key}: ${account.tokenEnv} is unset or empty`,
      });
    }
    yield* Effect.logDebug("credential resolved", { account: account.key, source: "env" });
    return Redacted.make(token);
  }),
};

export const layerEnv = Layer.succeed(CredentialStore, envStore);
