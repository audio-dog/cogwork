import { AttemptRecord, Claim, type LifecycleStage, type TriageRole } from "@clanker-forge/contracts";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { statusReason } from "../comments";
import { FollowUpMarker } from "../followUp";

const roleLabels = {
  "needs-triage": "needs-triage",
  "ready-for-agent": "ready-for-agent",
  "needs-info": "needs-info",
  "ready-for-human": "ready-for-human",
  wontfix: "wontfix",
} satisfies Record<TriageRole, string>;

const labelToRole = new Map<string, TriageRole>(
  Object.entries(roleLabels).map(([role, label]) => [label, role as TriageRole]),
);

const labels = { claim: "clanker-forge:claimed" } as const;
export const claimLabel = labels.claim;

const compact = <A>(value: A | undefined): ReadonlyArray<A> => (value === undefined ? [] : [value]);

const okToArray = <A>(result: Result.Result<A, unknown>): ReadonlyArray<A> =>
  Result.isSuccess(result) ? [result.success] : [];

export const rolesFromLabels = (labels: ReadonlyArray<string>) =>
  labels.flatMap((label) => compact(labelToRole.get(label)));

export const roleLabel = (role: TriageRole) => roleLabels[role];

export const hasClaimLabel = (labels: ReadonlyArray<string>) => labels.includes(claimLabel);

const markerPattern = (name: string) => new RegExp(`<!--\\s*clanker-forge:${name}\\s([^>]*)-->`, "g");

const anyMarkerPattern = /<!--\s*clanker-forge:[^>]*-->/g;
const clankerMarkerPattern = /<!--\s*clanker-forge:[^>]*-->/;
const ledgerMarkerPattern = /<!--\s*clanker-forge:ledger\s*-->/;
const detailMarkerPattern = /<!--\s*clanker-forge:detail\s*-->/;

export const stripMarkers = (text: string) => text.replace(anyMarkerPattern, "");

export const ledgerMarker = "<!-- clanker-forge:ledger -->";

const detailMarker = "<!-- clanker-forge:detail -->";

export const hasLedgerMarker = (body: string) => ledgerMarkerPattern.test(body);

export const hasClankerMarker = (body: string) => clankerMarkerPattern.test(body);

const before = (body: string, pattern: RegExp) => {
  const at = body.search(pattern);
  return at < 0 ? body : body.slice(0, at);
};

const after = (body: string, pattern: RegExp) => {
  const match = pattern.exec(body);
  return match ? body.slice(match.index + match[0].length) : "";
};

const orNull = (text: string) => text.trim() || null;

const coordinationRegion = (body: string) => before(body, detailMarkerPattern);

const toPair = (token: string) => {
  const eq = token.indexOf("=");
  return eq > 0 ? [[token.slice(0, eq), token.slice(eq + 1)] as const] : [];
};

const parsePairs = (payload: string) => Object.fromEntries(payload.split(/\s+/).flatMap(toPair));

const extractMarkers = (name: string, bodies: ReadonlyArray<string>) =>
  bodies.flatMap((body) =>
    [...coordinationRegion(body).matchAll(markerPattern(name))].map((match) => parsePairs(match[1] ?? "")),
  );

export const serializeClaim = (claim: Claim) => {
  const stage = claim.stage === undefined ? "" : ` stage=${claim.stage}`;
  return `<!-- clanker-forge:claim by=${claim.by} at=${claim.claimedAtMillis}${stage} -->`;
};

export const serializeAttempt = (attempt: AttemptRecord) =>
  `<!-- clanker-forge:attempt stage=${attempt.stage} outcome=${attempt.outcome} at=${attempt.atMillis} -->`;

export const serializeFollowUp = (marker: FollowUpMarker) =>
  `<!-- clanker-forge:follow-up checks=${marker.checks} human=${marker.humanCommentAtMillis} noProgress=${marker.noProgress} -->`;

const decodeClaim = Schema.decodeUnknownResult(Claim);
const decodeAttempt = Schema.decodeUnknownResult(AttemptRecord);
const decodeFollowUp = Schema.decodeUnknownResult(FollowUpMarker);

export const parseClaim = (bodies: ReadonlyArray<string>) => {
  const candidates = extractMarkers("claim", bodies).flatMap((pairs) =>
    okToArray(
      decodeClaim({
        by: pairs.by,
        claimedAtMillis: Number(pairs.at),
        ...(pairs.stage === undefined ? {} : { stage: pairs.stage }),
      }),
    ),
  );
  return candidates.at(-1) ?? null;
};

export const parseAttempts = (bodies: ReadonlyArray<string>) =>
  extractMarkers("attempt", bodies).flatMap((pairs) =>
    okToArray(decodeAttempt({ stage: pairs.stage, outcome: pairs.outcome, atMillis: Number(pairs.at) })),
  );

export const parseFollowUp = (bodies: ReadonlyArray<string>) =>
  extractMarkers("follow-up", bodies)
    .flatMap((pairs) =>
      okToArray(
        decodeFollowUp({
          checks: pairs.checks,
          humanCommentAtMillis: Number(pairs.human),
          noProgress: Number(pairs.noProgress),
        }),
      ),
    )
    .at(-1) ?? null;

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
  orNull(before(body, ledgerMarkerPattern).replace(attribution, ""));

export const coordinationDetail = (body: string) => orNull(after(body, detailMarkerPattern));

export const coordinationMarkers = (body: string) =>
  [...coordinationRegion(body).matchAll(anyMarkerPattern)]
    .map((match) => match[0])
    .filter((marker) => !ledgerMarkerPattern.test(marker));

interface CoordinationBody {
  readonly status: string;
  readonly markers: ReadonlyArray<string>;
  readonly detail: string | null;
}

const detailSection = (detail: string | null) => {
  const visible = orNull(stripMarkers(detail ?? ""));
  return visible === null ? [] : ["", detailMarker, "", visible];
};

export const formatNoteBody = (detail: string) => {
  const visible = orNull(stripMarkers(detail));
  return visible === null ? "" : [detailMarker, "", visible].join("\n");
};

export const formatCoordinationBody = ({ status, markers, detail }: CoordinationBody) =>
  [attribution, "", status, "", ledgerMarker, ...markers, ...detailSection(detail)].join("\n");
