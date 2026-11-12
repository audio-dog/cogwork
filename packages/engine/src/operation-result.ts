import type { StructuredOutputCompleteValue } from "@cogwork/contracts";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import type { HarnessCapabilityProfile } from "./harness";

const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1();

type ResultIssue = ReturnType<typeof formatIssues>["issues"][number];
type PathEntry = NonNullable<ResultIssue["path"]>[number];

export type RefusedResult = Data.TaggedEnum<{
  SchemaMismatch: { readonly issues: ReadonlyArray<ResultIssue> };
  ActionPlanRefused: { readonly message: string };
  PullRequestDeclined: { readonly reason: string };
  HarnessStreamFailed: { readonly detail: string };
}>;

export const RefusedResult = Data.taggedEnum<RefusedResult>();

const pathSegment = (entry: PathEntry, position: number) => {
  const key = typeof entry === "object" ? entry.key : entry;
  if (typeof key === "number") return `[${key}]`;
  return position === 0 ? String(key) : `.${String(key)}`;
};

const pathText = (path: ResultIssue["path"]) => path?.map(pathSegment).join("") || "the result";

const issueText = ({ path, message }: ResultIssue) => `${pathText(path)}: ${message}`;

export const acceptOperationResult = <S extends Schema.ConstraintDecoder<unknown>>(input: {
  readonly event: { readonly value: StructuredOutputCompleteValue } | undefined;
  readonly schema: S;
  readonly capabilities: HarnessCapabilityProfile | null;
}) =>
  Result.mapError(
    Schema.decodeUnknownResult(input.schema, { errors: "all" })(input.event?.value.object),
    (error): RefusedResult => RefusedResult.SchemaMismatch({ issues: formatIssues(error.issue).issues }),
  );

const failureDetail = (error: unknown) => {
  if (Cause.isTimeoutError(error)) return "the Run used all of its time budget";
  return error instanceof Error ? error.message : String(error);
};

export const harnessStreamFailed = (cause: Cause.Cause<unknown>) =>
  RefusedResult.HarnessStreamFailed({ detail: failureDetail(Cause.squash(cause)) });

export const refusalForAgent = RefusedResult.$match({
  SchemaMismatch: ({ issues }) =>
    [
      "Your previous result did not match the result schema. Correct each issue below, then return the complete result again.",
      ...issues.map((issue) => `- ${issueText(issue)}`),
    ].join("\n"),
  ActionPlanRefused: ({ message }) =>
    `The engine could not build an action plan from your previous result: ${message}. Change the result so that the engine can act on it.`,
  PullRequestDeclined: ({ reason }) =>
    `The engine did not open a pull request from your previous result: ${reason}. Correct the branch before you return the result.`,
  HarnessStreamFailed: ({ detail }) =>
    `Your previous Run stopped before it returned a result: ${detail}. Return the result before the Run ends.`,
});

export const refusalForPerson = RefusedResult.$match({
  SchemaMismatch: ({ issues }) =>
    `The agent's result did not match the Operation's result schema (${issues.map(issueText).join("; ")}).`,
  ActionPlanRefused: ({ message }) => `The engine could not act on the agent's result: ${message}.`,
  PullRequestDeclined: ({ reason }) => `The engine did not open the pull request: ${reason}.`,
  HarnessStreamFailed: ({ detail }) => `The Harness stopped before the agent returned a result: ${detail}.`,
});
