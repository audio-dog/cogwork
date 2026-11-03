import type { MarkerSpan, WireCodec } from "../github/markers";

export const ledgerMarker = "cogwork:ledger";
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

export const hasLedgerMarker = (body: string) => wireCodec.scan(body).some(({ name }) => name === "ledger");
export const hasCogworkMarker = (body: string) => wireCodec.scan(body).length > 0;
