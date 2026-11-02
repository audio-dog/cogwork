export interface MarkerSpan {
  readonly name: string;
  readonly pairs: string;
  readonly start: number;
  readonly end: number;
}

export interface WireCodec {
  readonly ledgerMarker: string;
  readonly encode: (marker: { readonly name: string; readonly pairs: string }) => string;
  readonly scan: (body: string) => ReadonlyArray<MarkerSpan>;
}

export const ledgerMarker = "<!-- cogwork:ledger -->";
export const agentNoteMarker = "<!-- cogwork:agent-note -->";

const scanPattern = /<!--\s*cogwork:([^>]*)-->/g;

export const wireCodec: WireCodec = {
  ledgerMarker,
  encode: ({ name, pairs }) => `<!-- cogwork:${name}${pairs ? ` ${pairs}` : ""} -->`,
  scan: (body) =>
    [...body.matchAll(scanPattern)].flatMap((match) => {
      const inner = (match[1] ?? "").trim();
      const gap = inner.search(/\s/);
      const name = gap < 0 ? inner : inner.slice(0, gap);
      if (!name) return [];
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

export const hasLedgerMarker = (body: string) => body.includes(ledgerMarker);
export const hasCogworkMarker = (body: string) => wireCodec.scan(body).length > 0;
