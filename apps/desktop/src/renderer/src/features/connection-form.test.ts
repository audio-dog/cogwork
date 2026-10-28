import * as Redacted from "effect/Redacted";
import { describe, expect, it } from "vitest";
import {
  type EstablishmentFields,
  EstablishmentFieldsValidator,
  emptyEstablishmentFields,
  establishmentFrom,
} from "./connection-form";

const validate = (fields: Partial<EstablishmentFields>) =>
  EstablishmentFieldsValidator["~standard"].validate({
    ...emptyEstablishmentFields("github"),
    ...fields,
  });

const issuesOf = (result: ReturnType<typeof validate>) => {
  if (result instanceof Promise) throw new Error("validation is synchronous");
  return (result.issues ?? []).map((issue) => ({
    path: [...(issue.path ?? [])],
    message: issue.message,
  }));
};

describe("Connection form", () => {
  it("opens ready for a pasted API key", () => {
    expect(emptyEstablishmentFields("github").source).toBe("ApiKey");
  });

  it("requires an account only for Linear", () => {
    expect(issuesOf(validate({ account: "   ", apiKey: "secret" }))).toEqual([]);
    expect(issuesOf(validate({ system: "linear", account: "   ", apiKey: "secret" }))).toEqual([
      { path: ["account"], message: "Name the account this Connection signs in as." },
    ]);
  });

  it("requires only the credential the chosen source reads, and says so on that field", () => {
    expect(issuesOf(validate({ account: "acme", source: "ApiKey", apiKey: "" }))).toEqual([
      { path: ["apiKey"], message: "Paste the API key." },
    ]);
    expect(issuesOf(validate({ account: "acme", source: "Env", environment: "" }))).toEqual([
      { path: ["environment"], message: "Name the environment variable to read." },
    ]);
    expect(
      issuesOf(validate({ system: "linear", account: "acme", source: "Stored", environment: "" })),
    ).toEqual([]);
    expect(
      issuesOf(validate({ system: "granola", account: "person@example.com", apiKey: "  grn_secret  " })),
    ).toEqual([]);
  });

  it("builds an Establishment whose key is redacted", () => {
    const establishment = establishmentFrom({
      ...emptyEstablishmentFields("github", "  acme  "),
      apiKey: "ghp_secret",
    });
    expect(establishment).not.toHaveProperty("account");
    expect(establishment.source._tag).toBe("ApiKey");
    if (establishment.source._tag !== "ApiKey") throw new Error("expected an API key source");
    expect(String(establishment.source.key)).not.toContain("ghp_secret");
    expect(Redacted.value(establishment.source.key)).toBe("ghp_secret");
  });

  it("builds the GitHub CLI marker without an account or token", () => {
    expect(
      establishmentFrom({
        ...emptyEstablishmentFields("github"),
        source: "GitHubCli",
      }),
    ).toEqual({ system: "github", source: { _tag: "GitHubCli" } });
  });

  it("carries the environment reference through without copying a value", () => {
    const establishment = establishmentFrom({
      ...emptyEstablishmentFields("linear", "acme"),
      source: "Env",
    });
    expect(establishment.source).toEqual({ _tag: "Env", name: "LINEAR_API_KEY" });
  });
});
