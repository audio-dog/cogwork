import { AttemptRecord, Claim, type TriageRole } from "@clanker-forge/contracts";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

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

export const hasClaimLabel = (labels: ReadonlyArray<string>) => labels.includes(claimLabel);

const markerPattern = (name: string) => new RegExp(`<!--\\s*clanker-forge:${name}\\s([^>]*)-->`, "g");

const toPair = (token: string) => {
  const eq = token.indexOf("=");
  return eq > 0 ? [[token.slice(0, eq), token.slice(eq + 1)] as const] : [];
};

const parsePairs = (payload: string) => Object.fromEntries(payload.split(/\s+/).flatMap(toPair));

const extractMarkers = (name: string, bodies: ReadonlyArray<string>) =>
  bodies.flatMap((body) =>
    [...body.matchAll(markerPattern(name))].map((match) => parsePairs(match[1] ?? "")),
  );

export const serializeClaim = (claim: Claim) =>
  `<!-- clanker-forge:claim by=${claim.by} at=${claim.claimedAtMillis} -->`;

export const serializeAttempt = (attempt: AttemptRecord) =>
  `<!-- clanker-forge:attempt stage=${attempt.stage} outcome=${attempt.outcome} at=${attempt.atMillis} -->`;

const decodeClaim = Schema.decodeUnknownResult(Claim);
const decodeAttempt = Schema.decodeUnknownResult(AttemptRecord);

export const parseClaim = (bodies: ReadonlyArray<string>) => {
  const candidates = extractMarkers("claim", bodies).flatMap((pairs) =>
    okToArray(decodeClaim({ by: pairs.by, claimedAtMillis: Number(pairs.at) })),
  );
  return candidates.at(-1) ?? null;
};

export const parseAttempts = (bodies: ReadonlyArray<string>) =>
  extractMarkers("attempt", bodies).flatMap((pairs) =>
    okToArray(decodeAttempt({ stage: pairs.stage, outcome: pairs.outcome, atMillis: Number(pairs.at) })),
  );
