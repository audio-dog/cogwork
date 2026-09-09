import { ConnectionEstablishment, type ConnectionSystem } from "@cogwork/contracts";
import * as Schema from "effect/Schema";

// The form holds the source's tag, not a parallel "method" vocabulary, so the value the Select
// carries is the tag the Establishment is built from and no second mapping can drift from it.
export const CredentialSourceTag = Schema.Literals(["ApiKey", "Env", "GitHubCli", "Stored"]);
export type CredentialSourceTag = typeof CredentialSourceTag.Type;

export const environmentVariableFor = (system: ConnectionSystem) =>
  system === "github" ? "GITHUB_TOKEN" : "LINEAR_API_KEY";

// One flat record, because that is what the form binds to: every field stays mounted so switching
// source keeps what was already typed. Which credential field is *required* is the filter's job.
export const EstablishmentFields = Schema.Struct({
  system: Schema.Literals(["github", "linear"]),
  account: Schema.String,
  source: CredentialSourceTag,
  apiKey: Schema.String,
  environment: Schema.String,
}).check(
  // A struct-level filter is what lets the conditional requirement report at the field the person
  // is looking at: `path` puts the issue on `apiKey`/`environment`, not on the form as a whole.
  Schema.makeFilter((fields) => {
    if (fields.system === "linear" && fields.account.trim() === "")
      return { path: ["account"], issue: "Name the account this Connection signs in as." };
    if (fields.source === "ApiKey" && fields.apiKey.trim() === "")
      return { path: ["apiKey"], issue: "Paste the API key." };
    if (fields.source === "Env" && fields.environment.trim() === "")
      return { path: ["environment"], issue: "Name the environment variable to read." };
    return undefined;
  }),
);
export type EstablishmentFields = typeof EstablishmentFields.Type;

// TanStack Form reads validators through Standard Schema, and the issue paths Effect emits are the
// field names, so field-level errors need no mapping layer.
export const EstablishmentFieldsValidator = Schema.toStandardSchemaV1(EstablishmentFields);

export const emptyEstablishmentFields = (system: ConnectionSystem, account = ""): EstablishmentFields => ({
  system,
  account,
  source: "ApiKey",
  apiKey: "",
  environment: environmentVariableFor(system),
});

const sourceOf = (fields: EstablishmentFields) => {
  if (fields.source === "Stored") return { _tag: "Stored" as const };
  if (fields.source === "GitHubCli") return { _tag: "GitHubCli" as const };
  if (fields.source === "Env") return { _tag: "Env" as const, name: fields.environment };
  return { _tag: "ApiKey" as const, key: fields.apiKey };
};

// Decoding the *encoded* Establishment is what redacts the key — building the value by hand would
// mean calling `Redacted.make` here and trusting every future caller to remember.
const decodeEstablishment = Schema.decodeUnknownSync(ConnectionEstablishment);

export const establishmentFrom = (fields: EstablishmentFields) =>
  decodeEstablishment(
    fields.system === "github"
      ? { system: fields.system, source: sourceOf(fields) }
      : { system: fields.system, account: fields.account.trim(), source: sourceOf(fields) },
  );
