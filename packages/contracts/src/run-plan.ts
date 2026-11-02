import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HarnessName, TrimmedNonEmptyString, WorkItemId } from "./base-schemas";
import { Claim } from "./coordination";
import { ProvenanceStamp } from "./provenance";
import { RunId, SessionKind } from "./run";
import { ModelOptionSelections, ResolutionOperator, RunPlanPolicyProfile } from "./settings";
import { Priority } from "./work-item";

export class RunPlanHarness extends Schema.Class<RunPlanHarness>("RunPlanHarness")({
  name: HarnessName,
  model: Schema.NullOr(TrimmedNonEmptyString),
  options: ModelOptionSelections.pipe(
    Schema.withConstructorDefault(Effect.succeed({})),
    Schema.withDecodingDefaultKey(Effect.succeed({})),
  ),
  profile: RunPlanPolicyProfile,
}) {}

export class RunPlanInstruction extends Schema.Class<RunPlanInstruction>("RunPlanInstruction")({
  kind: Schema.Literals(["rules", "repo", "operating-instructions"]),
  source: TrimmedNonEmptyString,
  content: TrimmedNonEmptyString,
}) {}

export class RunPlanResource extends Schema.Class<RunPlanResource>("RunPlanResource")({
  source: TrimmedNonEmptyString,
  content: TrimmedNonEmptyString,
}) {}

export class RunPlanOperatingInstructions extends Schema.Class<RunPlanOperatingInstructions>(
  "RunPlanOperatingInstructions",
)({
  name: TrimmedNonEmptyString,
  path: TrimmedNonEmptyString,
  resources: Schema.Array(RunPlanResource),
}) {}

export class RunPlanMcpServer extends Schema.Class<RunPlanMcpServer>("RunPlanMcpServer")({
  identity: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  projectedName: TrimmedNonEmptyString,
  endpoint: TrimmedNonEmptyString,
  authenticated: Schema.Boolean,
  unavailableReason: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
  ),
}) {}

export class RunPlanContributionMember extends Schema.Class<RunPlanContributionMember>(
  "RunPlanContributionMember",
)({
  identity: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  source: TrimmedNonEmptyString,
  unavailableReason: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
}) {}

export class RunPlanMessage extends Schema.Class<RunPlanMessage>("RunPlanMessage")({
  role: Schema.Literal("user"),
  content: TrimmedNonEmptyString,
}) {}

export class RunPlanObservation extends Schema.Class<RunPlanObservation>("RunPlanObservation")({
  generation: Schema.Natural,
  observedAtMillis: Schema.Natural,
}) {}

export class RunPlanWorkContextReference extends Schema.Class<RunPlanWorkContextReference>(
  "RunPlanWorkContextReference",
)({
  workItem: WorkItemId,
  url: Schema.NullOr(TrimmedNonEmptyString),
}) {}

export const RunPlanFollowUpTrigger = Schema.Struct({
  kind: Schema.Literals(["human-feedback", "trusted-bot-finding", "failing-check", "merge-conflict"]),
  atMillis: Schema.Natural,
});
export type RunPlanFollowUpTrigger = typeof RunPlanFollowUpTrigger.Type;

export class RunPlanWorkContextFacts extends Schema.Class<RunPlanWorkContextFacts>("RunPlanWorkContextFacts")(
  {
    assignees: Schema.Array(TrimmedNonEmptyString),
    openBlockers: Schema.Natural,
    claim: Schema.NullOr(Claim),
    priority: Priority,
  },
) {}

export class RunPlanWorkContextComment extends Schema.Class<RunPlanWorkContextComment>(
  "RunPlanWorkContextComment",
)({
  author: Schema.NullOr(TrimmedNonEmptyString),
  authorAssociation: Schema.NullOr(TrimmedNonEmptyString),
  body: Schema.String,
  createdAtMillis: Schema.Natural,
}) {}

export class RunPlanWorkContextProse extends Schema.Class<RunPlanWorkContextProse>("RunPlanWorkContextProse")(
  {
    body: Schema.String,
    comments: Schema.Array(RunPlanWorkContextComment),
  },
) {}

export const RunPlanMcpMember = Schema.Union([RunPlanMcpServer, RunPlanContributionMember]);
export type RunPlanMcpMember = typeof RunPlanMcpMember.Type;

export class RunPlanWorkContext extends Schema.Class<RunPlanWorkContext>("RunPlanWorkContext")({
  reference: RunPlanWorkContextReference,
  facts: RunPlanWorkContextFacts,
  prose: RunPlanWorkContextProse,
  observation: RunPlanObservation,
}) {}

export class RunPlanResolutionCandidate extends Schema.Class<RunPlanResolutionCandidate>(
  "RunPlanResolutionCandidate",
)({
  scope: TrimmedNonEmptyString,
  level: TrimmedNonEmptyString,
  source: TrimmedNonEmptyString,
  value: Schema.Unknown,
}) {}

export class RunPlanDroppedCandidate extends Schema.Class<RunPlanDroppedCandidate>("RunPlanDroppedCandidate")(
  {
    candidate: RunPlanResolutionCandidate,
    reason: TrimmedNonEmptyString,
  },
) {}

export class RunPlanResolutionTrace extends Schema.Class<RunPlanResolutionTrace>("RunPlanResolutionTrace")({
  key: TrimmedNonEmptyString,
  operator: ResolutionOperator,
  winner: Schema.NullOr(RunPlanResolutionCandidate),
  contributors: Schema.Array(RunPlanResolutionCandidate),
  shadowed: Schema.Array(RunPlanResolutionCandidate),
  dropped: Schema.Array(RunPlanDroppedCandidate),
}) {}

export class RunPlanProjectedName extends Schema.Class<RunPlanProjectedName>("RunPlanProjectedName")({
  identity: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
}) {}

export const RunPlanMember = Schema.Literals([
  "Harness Adapter",
  "Instructions",
  "Messages",
  "Work Context",
  "Tools",
  "Skills",
  "MCP",
  "Subagents",
  "Commands",
  "Hooks",
  "Middleware",
  "Sandbox",
  "Structured Output",
  "Persistence",
  "Connections",
  "Provenance",
]);
export type RunPlanMember = typeof RunPlanMember.Type;

export class RunPlanProjectionDisposition extends Schema.Class<RunPlanProjectionDisposition>(
  "RunPlanProjectionDisposition",
)({
  member: TrimmedNonEmptyString,
  disposition: Schema.Literals(["projected", "not-projected"]),
  reason: Schema.optionalKey(TrimmedNonEmptyString),
}) {}

export class RunPlanProvenance extends Schema.Class<RunPlanProvenance>("RunPlanProvenance")({
  resolution: Schema.Array(RunPlanResolutionTrace),
  stamps: Schema.Array(ProvenanceStamp),
  projectedNames: Schema.Array(RunPlanProjectedName),
  projection: Schema.Array(RunPlanProjectionDisposition),
  observation: RunPlanObservation,
}) {}

export class RunPlanSandbox extends Schema.Class<RunPlanSandbox>("RunPlanSandbox")({
  workspace: Schema.NullOr(TrimmedNonEmptyString),
  policy: RunPlanPolicyProfile,
}) {}

export class RunPlanPersistence extends Schema.Class<RunPlanPersistence>("RunPlanPersistence")({
  sessionKind: SessionKind,
}) {}

export const RunPlanMiddlewareName = Schema.Literals(["sandbox", "persistence", "instruction-context"]);
export type RunPlanMiddlewareName = typeof RunPlanMiddlewareName.Type;

const StructuredOutput = Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown));

export class RunPlan extends Schema.Class<RunPlan>("RunPlan")({
  id: RunId,
  operation: TrimmedNonEmptyString,
  harness: RunPlanHarness,
  instructions: Schema.Array(RunPlanInstruction),
  operatingInstructions: RunPlanOperatingInstructions,
  messages: Schema.Array(RunPlanMessage),
  tools: Schema.Array(TrimmedNonEmptyString),
  skills: Schema.Array(RunPlanContributionMember),
  mcp: Schema.Array(RunPlanMcpMember),
  subagents: Schema.Array(RunPlanContributionMember),
  commands: Schema.Array(RunPlanContributionMember),
  hooks: Schema.Array(RunPlanContributionMember),
  middleware: Schema.Array(RunPlanMiddlewareName),
  structuredOutput: StructuredOutput,
  connections: Schema.Array(TrimmedNonEmptyString),
  workContext: RunPlanWorkContext,
  sandbox: RunPlanSandbox,
  persistence: RunPlanPersistence,
  provenance: RunPlanProvenance,
}) {}
