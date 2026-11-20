import { encode } from "gpt-tokenizer/model/gpt-4o";
import { assert, describe, it } from "vitest";

import { estimateTokens } from "./harness";

// The estimator turns the text that crosses the ACP wire (the prompt we send plus
// the streamed assistant + reasoning text) into a token count with `chars / 4`.
// Cursor never reports real usage over ACP, so we can't check the estimate against
// the model's own count — and print-mode `usage` is the wrong yardstick because it
// is dominated by the hidden system prompt, tool schemas, and reasoning the wire
// never carries. What we *can* pin is the heuristic itself: does `chars / 4` track a
// real BPE tokenizer on representative text? gpt-4o's o200k tokenizer stands in as a
// stable, offline proxy — token density is close enough across modern tokenizers for
// a "somewhat accurate" claim.
const corpus: ReadonlyArray<{ readonly label: string; readonly text: string }> = [
  {
    label: "issue prose",
    text: "The triage run captures the session handle but never records token usage, so the ledger's token columns stay empty and there are no per-run cost insights. We want a completed run to record input, output, and total tokens whenever the harness can provide them, and for the runs view to surface that usage so a maintainer can spot an expensive run at a glance.",
  },
  {
    label: "markdown issue",
    text: [
      "## Summary",
      "",
      "`cogwork runs` shows empty token columns. Expected behaviour:",
      "",
      "- A completed triage run records non-null `input`/`output`/`total` tokens.",
      "- The desktop drill-in surfaces usage for the run.",
      "- If ACP genuinely can't report usage, document the fallback.",
      "",
      "### Notes",
      "See `packages/cursor-acp/FINDINGS.md` (Q2) for the ACP probe results.",
    ].join("\n"),
  },
  {
    label: "typescript code",
    text: [
      "export const withEstimatedUsage = (promptChars: number, stream: Stream<AgUiEvent>) =>",
      "  Stream.mapAccum(stream, () => 0, (streamed, event) => {",
      "    const next = streamed + outputChars(event);",
      "    const emit = event.type === 'RUN_FINISHED' && !event.usage",
      "      ? { ...event, usage: estimatedUsage(promptChars, next) }",
      "      : event;",
      "    return [next, [emit]] as const;",
      "  });",
    ].join("\n"),
  },
  {
    label: "json payload",
    text: '{"type":"RUN_FINISHED","finishReason":"stop","usage":{"promptTokens":1284,"completionTokens":417,"totalTokens":1701,"estimated":true},"threadId":"run-9f2c","messages":[{"role":"assistant","id":"msg-01"}]}',
  },
  {
    label: "agent output",
    text: "I traced the empty token columns to the harness runner. Cursor's `agent acp` returns `{stopReason}` with no `usage`, so nothing rides on RUN_FINISHED. I added `withEstimatedUsage`, which folds the streamed text and fills a `chars/4` estimate when the terminal event has none. The flag is marked `estimated` so the CLI prints `~N` and the desktop shows a tooltip. Next I'll wire the resume policy to ignore the estimate, since it undercounts the real transcript.",
  },
];

const ratioOf = (text: string) => {
  const real = encode(text).length;
  return { real, estimate: estimateTokens(text.length), ratio: estimateTokens(text.length) / real };
};

describe("chars/4 token estimate vs a real tokenizer", () => {
  // Measured ratios (o200k) are recorded in FINDINGS.md; the bands below are the guard rails.
  it("stays within +/-40% of the tokenizer on every representative sample", () => {
    for (const { label, text } of corpus) {
      const { ratio } = ratioOf(text);
      assert.isAtLeast(ratio, 0.6, `${label} underestimates too far (est/real=${ratio.toFixed(2)})`);
      assert.isAtMost(ratio, 1.4, `${label} overestimates too far (est/real=${ratio.toFixed(2)})`);
    }
  });

  it("tracks the tokenizer within +/-25% across the whole corpus", () => {
    const totals = corpus.reduce(
      (acc, { text }) => {
        const { real, estimate } = ratioOf(text);
        return { real: acc.real + real, estimate: acc.estimate + estimate };
      },
      { real: 0, estimate: 0 },
    );

    const ratio = totals.estimate / totals.real;
    assert.isAtLeast(ratio, 0.75);
    assert.isAtMost(ratio, 1.25);
  });
});
