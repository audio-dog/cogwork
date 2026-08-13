import type { TriageRole, TriageRoleLabels } from "@cogwork/contracts";
import type { MarkerSpan, WireCodec } from "../coordination";
import * as Coordination from "../coordination";

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

export const claimLabel = "cogwork:claimed";

export const canceledStateName = "Canceled";

export const roleLabelsFor = (overrides?: TriageRoleLabels): Record<TriageRole, string> => ({
  "needs-triage": overrides?.["needs-triage"] ?? defaultRoleLabels["needs-triage"],
  "ready-for-agent": overrides?.["ready-for-agent"] ?? defaultRoleLabels["ready-for-agent"],
  "needs-info": overrides?.["needs-info"] ?? defaultRoleLabels["needs-info"],
  "ready-for-human": overrides?.["ready-for-human"] ?? defaultRoleLabels["ready-for-human"],
  wontfix: overrides?.wontfix ?? defaultRoleLabels.wontfix,
});

const compact = <A>(value: A | undefined): ReadonlyArray<A> => (value === undefined ? [] : [value]);

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

export const ledgerMarker = "cogwork:ledger";

// A marker is only real at the start of a line, which keeps an indented sample in prose inert.
const scanPattern = /^cogwork:([\w-]+)(?:[ \t]+(.*))?$/gm;

export const wireCodec: WireCodec = {
  ledgerMarker,
  encode: ({ name, pairs }) => `cogwork:${name}${pairs ? ` ${pairs}` : ""}`,
  scan: (body): ReadonlyArray<MarkerSpan> =>
    [...body.matchAll(scanPattern)].map((match) => ({
      name: match[1] ?? "",
      pairs: (match[2] ?? "").trim(),
      start: match.index,
      end: match.index + match[0].length,
    })),
};

export const hasLedgerMarker = (body: string) => Coordination.hasLedgerMarker(wireCodec, body);

export const hasCogworkMarker = (body: string) => Coordination.hasCogworkMarker(wireCodec, body);
