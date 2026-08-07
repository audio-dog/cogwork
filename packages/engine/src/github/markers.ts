import type { TriageRole } from "@clanker-forge/contracts";
import type { MarkerSpan, WireCodec } from "../coordination";
import * as Coordination from "../coordination";

const triageRoles = [
  "needs-triage",
  "ready-for-agent",
  "needs-info",
  "ready-for-human",
  "wontfix",
] as const satisfies ReadonlyArray<TriageRole>;

const roleLabels = {
  "needs-triage": "needs-triage",
  "ready-for-agent": "ready-for-agent",
  "needs-info": "needs-info",
  "ready-for-human": "ready-for-human",
  wontfix: "wontfix",
} satisfies Record<TriageRole, string>;

const labelToRole = new Map(triageRoles.map((role) => [roleLabels[role], role]));

export const claimLabel = "clanker-forge:claimed";

const compact = <A>(value: A | undefined): ReadonlyArray<A> => (value === undefined ? [] : [value]);

export const rolesFromLabels = (labels: ReadonlyArray<string>) =>
  labels.flatMap((label) => compact(labelToRole.get(label)));

export const roleLabel = (role: TriageRole) => roleLabels[role];

export const hasClaimLabel = (labels: ReadonlyArray<string>) => labels.includes(claimLabel);

export const ledgerMarker = "<!-- clanker-forge:ledger -->";

// GitHub renders HTML comments invisibly, so markers can sit inline without a reader ever seeing them.
const scanPattern = /<!--\s*clanker-forge:([^>]*)-->/g;

export const wireCodec: WireCodec = {
  ledgerMarker,
  encode: ({ name, pairs }) => `<!-- clanker-forge:${name}${pairs ? ` ${pairs}` : ""} -->`,
  scan: (body): ReadonlyArray<MarkerSpan> =>
    [...body.matchAll(scanPattern)].flatMap((match) => {
      const inner = (match[1] ?? "").trim();
      const gap = inner.search(/\s/);
      const name = gap < 0 ? inner : inner.slice(0, gap);
      if (name === "") return [];
      return [
        {
          name,
          pairs: gap < 0 ? "" : inner.slice(gap + 1).trim(),
          start: match.index,
          end: match.index + match[0].length,
        },
      ];
    }),
};

export const hasLedgerMarker = (body: string) => Coordination.hasLedgerMarker(wireCodec, body);

export const hasClankerMarker = (body: string) => Coordination.hasClankerMarker(wireCodec, body);
