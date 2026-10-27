import { createHighlighter, type HighlightToken } from "@tanstack/highlight/core";
import { diff } from "@tanstack/highlight/languages/diff";
import { json } from "@tanstack/highlight/languages/json";
import { markdown } from "@tanstack/highlight/languages/markdown";
import { shell } from "@tanstack/highlight/languages/shell";
import { ts } from "@tanstack/highlight/languages/ts";
import { tsx } from "@tanstack/highlight/languages/tsx";

export const highlighter = createHighlighter({ languages: [diff, json, markdown, shell, ts, tsx] });

type Piece = HighlightToken | "break";

const toPieces = (token: HighlightToken) =>
  token.value
    .split("\n")
    .flatMap((value, index): Piece[] =>
      index === 0 ? [{ ...token, value }] : ["break", { ...token, value }],
    );

const isVisible = (piece: Piece): piece is HighlightToken => piece !== "break" && piece.value !== "";

export const highlightLines = (code: string, lang: string) => {
  const pieces = highlighter.tokenize(code.replace(/\n$/, ""), { lang }).tokens.flatMap(toPieces);
  const breaks = pieces.flatMap((piece, index) => (piece === "break" ? [index] : []));
  return [-1, ...breaks].map((previousBreak, line) =>
    pieces.slice(previousBreak + 1, breaks[line]).filter(isVisible),
  );
};
