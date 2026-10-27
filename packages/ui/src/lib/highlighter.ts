import { createHighlighter, type HighlightToken } from "@tanstack/highlight/core";
import { diff } from "@tanstack/highlight/languages/diff";
import { json } from "@tanstack/highlight/languages/json";
import { markdown } from "@tanstack/highlight/languages/markdown";
import { shell } from "@tanstack/highlight/languages/shell";
import { ts } from "@tanstack/highlight/languages/ts";
import { tsx } from "@tanstack/highlight/languages/tsx";

/** The one registry every code surface shares, so a language highlights the same everywhere. */
export const highlighter = createHighlighter({ languages: [diff, json, markdown, shell, ts, tsx] });

/** Tokens split into lines; a token that spans a newline is cut at it. */
export const highlightLines = (code: string, lang: string) => {
  const pieces = highlighter
    .tokenize(code.replace(/\n$/, ""), { lang })
    .tokens.flatMap((token) =>
      token.value
        .split("\n")
        .flatMap(
          (value, index): Array<HighlightToken | "break"> =>
            index === 0 ? [{ ...token, value }] : ["break", { ...token, value }],
        ),
    );
  const lines: HighlightToken[][] = [[]];
  for (const piece of pieces) {
    if (piece === "break") lines.push([]);
    else if (piece.value) lines.at(-1)?.push(piece);
  }
  return lines;
};
