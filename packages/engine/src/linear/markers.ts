import {
  AttemptRecord,
  Claim,
  type LifecycleStage,
  type TriageRole,
  type TriageRoleLabels,
} from "@clanker-forge/contracts";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { statusReason } from "../comments";
import { FollowUpMarker } from "../follow-up";

const triageRoles = [
  "needs-triage",
  "ready-for-agent",
  "needs-info",
  "ready-for-human",
  "wontfix",
] as const satisfies ReadonlyArray<TriageRole>;

export const defaultRoleLabels = {
  "needs-triage": "state:needs-triage",
  "ready-for-agent": "state:ready-for-agent",
  "needs-info": "state:needs-info",
  "ready-for-human": "state:ready-for-human",
  wontfix: "state:wontfix",
} satisfies Record<TriageRole, string>;

export const claimLabel = "clanker-forge:claimed";

export const canceledStateName = "Canceled";

export const roleLabelsFor = (overrides?: TriageRoleLabels): Record<TriageRole, string> => ({
  "needs-triage": overrides?.["needs-triage"] ?? defaultRoleLabels["needs-triage"],
  "ready-for-agent": overrides?.["ready-for-agent"] ?? defaultRoleLabels["ready-for-agent"],
  "needs-info": overrides?.["needs-info"] ?? defaultRoleLabels["needs-info"],
  "ready-for-human": overrides?.["ready-for-human"] ?? defaultRoleLabels["ready-for-human"],
  wontfix: overrides?.wontfix ?? defaultRoleLabels.wontfix,
});

const compact = <A>(value: A | undefined): ReadonlyArray<A> => (value === undefined ? [] : [value]);

const okToArray = <A>(result: Result.Result<A, unknown>): ReadonlyArray<A> =>
  Result.isSuccess(result) ? [result.success] : [];

const lastOf = <A>(items: ReadonlyArray<A>) => items.at(-1) ?? null;

export const rolesFrom = (
  labels: ReadonlyArray<string>,
  state: { readonly name: string; readonly type: string },
  roleLabels: Record<TriageRole, string>,
): ReadonlyArray<TriageRole> => {
  const labelToRole = new Map(triageRoles.map((role) => [roleLabels[role], role]));
  const fromLabels = labels.flatMap((label) => compact(labelToRole.get(label)));
  const canceled = state.name === canceledStateName || state.type === "canceled";
  if (!canceled || fromLabels.includes("wontfix")) {
    return fromLabels;
  }
  return [...fromLabels, "wontfix"];
};

export const roleLabel = (role: TriageRole, roleLabels: Record<TriageRole, string>) => roleLabels[role];

export const hasClaimLabel = (labels: ReadonlyArray<string>) => labels.includes(claimLabel);

const linePattern = (name: string) => new RegExp(`^clanker-forge:${name}(?:\\s+(.*))?$`, "gm");

export const ledgerMarker = "clanker-forge:ledger";
const detailLine = "clanker-forge:detail";
const ledgerPattern = /^clanker-forge:ledger\s*$/m;
const detailPattern = /^clanker-forge:detail\s*$/m;
const coordinationMarkerPattern = /^clanker-forge:\S+.*$/gm;
const clankerMarkerPattern = /^clanker-forge:\S+/m;

export const hasLedgerMarker = (body: string) => ledgerPattern.test(body);

export const hasClankerMarker = (body: string) => clankerMarkerPattern.test(body);

const stripMarkerLines = (text: string) => text.replace(coordinationMarkerPattern, "");

const before = (body: string, pattern: RegExp) => {
  const at = body.search(pattern);
  return at < 0 ? body : body.slice(0, at);
};

const after = (body: string, pattern: RegExp) => {
  const match = pattern.exec(body);
  return match ? body.slice(match.index + match[0].length) : "";
};

const orNull = (text: string) => text.trim() || null;

const coordinationRegion = (body: string) => before(body, detailPattern);

const toPair = (token: string) => {
  const eq = token.indexOf("=");
  return eq > 0 ? [[token.slice(0, eq), token.slice(eq + 1)] as const] : [];
};

const parsePairs = (payload: string) => Object.fromEntries(payload.split(/\s+/).flatMap(toPair));

const extractLines = (name: string, body: string) =>
  [...coordinationRegion(body).matchAll(linePattern(name))].map((match) => parsePairs(match[1] ?? ""));

export const serializeClaim = (claim: Claim) =>
  `clanker-forge:claim by=${claim.by} at=${claim.claimedAtMillis}`;

export const serializeAttempt = (attempt: AttemptRecord) =>
  `clanker-forge:attempt stage=${attempt.stage} outcome=${attempt.outcome} at=${attempt.atMillis}`;

export const serializeFollowUp = (marker: FollowUpMarker) =>
  `clanker-forge:follow-up checks=${marker.checks} human=${marker.humanCommentAtMillis} noProgress=${marker.noProgress} base=${marker.baseDivergence}`;

const decodeClaim = Schema.decodeUnknownResult(Claim);
const decodeAttempt = Schema.decodeUnknownResult(AttemptRecord);
const decodeFollowUp = Schema.decodeUnknownResult(FollowUpMarker);

export const parseFollowUp = (coordinationBody: string) =>
  lastOf(
    extractLines("follow-up", coordinationBody).flatMap((pairs) =>
      okToArray(
        decodeFollowUp({
          checks: pairs.checks,
          humanCommentAtMillis: Number(pairs.human),
          noProgress: Number(pairs.noProgress),
          // Markers written before base divergence existed have no `base=`; read them as "none".
          baseDivergence: pairs.base ?? "none",
        }),
      ),
    ),
  );

export const parseClaim = (coordinationBody: string) =>
  lastOf(
    extractLines("claim", coordinationBody).flatMap((pairs) =>
      okToArray(decodeClaim({ by: pairs.by, claimedAtMillis: Number(pairs.at) })),
    ),
  );

export const parseAttempts = (coordinationBody: string) =>
  extractLines("attempt", coordinationBody).flatMap((pairs) =>
    okToArray(decodeAttempt({ stage: pairs.stage, outcome: pairs.outcome, atMillis: Number(pairs.at) })),
  );

const stageGerund: Record<LifecycleStage, string> = {
  triage: "triaging",
  implement: "implementing",
  "follow-up": "following up on",
  verify: "verifying",
};

export const claimStatus = (stage: LifecycleStage) => `Currently ${stageGerund[stage]} this issue.`;

export const attemptStatus = (attempt: AttemptRecord, reason?: string | null) => {
  if (attempt.outcome === "succeeded") return `${attempt.stage} completed.`;
  if (attempt.outcome === "abandoned") return `${attempt.stage} abandoned.`;
  const trimmed = reason ? statusReason(reason) : "";
  if (trimmed) return `Last ${attempt.stage} attempt failed: ${trimmed}`;
  return `Last ${attempt.stage} attempt failed.`;
};

export const defaultStatus = "Working on this issue.";

const attribution = "> *This was posted by clanker-forge.*";

export const coordinationStatus = (body: string) =>
  orNull(before(body, ledgerPattern).replace(attribution, ""));

export const coordinationDetail = (body: string) => orNull(after(body, detailPattern));

export const coordinationMarkers = (body: string) =>
  [...coordinationRegion(body).matchAll(coordinationMarkerPattern)]
    .map((match) => match[0])
    .filter((marker) => marker !== ledgerMarker && !marker.startsWith(detailLine));

interface CoordinationBody {
  readonly status: string;
  readonly markers: ReadonlyArray<string>;
  readonly detail: string | null;
}

const detailSection = (detail: string | null) => {
  const visible = orNull(detail ?? "");
  return visible === null ? [] : ["", detailLine, "", visible];
};

export const formatNoteBody = (detail: string) => orNull(stripMarkerLines(detail)) ?? "";

export const formatCoordinationBody = ({ status, markers, detail }: CoordinationBody) =>
  [attribution, "", status, "", ledgerMarker, ...markers, ...detailSection(detail)].join("\n");
