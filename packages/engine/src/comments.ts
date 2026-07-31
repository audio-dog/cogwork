import type { LifecycleStage } from "@clanker-forge/contracts";

const attribution = "> *This was posted by clanker-forge.*";

const resultLine = /^\s*(?:IMPLEMENT|FOLLOWUP|TRIAGE)-(?:RESULT|DECISION):.*$/gim;
const markerNoise = /<!--\s*clanker-forge:[^>]*-->/g;

const maxReasonChars = 800;

export type BlockCause =
  | { readonly kind: "exhausted"; readonly attempts: number }
  | { readonly kind: "non-retryable" };

const attemptWord = (count: number) => (count === 1 ? "attempt" : "attempts");

export const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

export const truncate = (text: string, max = maxReasonChars) => {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
};

export const stripResultLines = (text: string) => text.replace(resultLine, "").trim();

export const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export const attachCommand = (checkoutPath: string, sessionId: string) =>
  `cd ${shellQuote(checkoutPath)} && agent --resume ${shellQuote(sessionId)}`;

export const recoveryReason = "worker did not survive a daemon restart";

export const statusReason = (reason: string) => oneLine(truncate(reason.replace(markerNoise, "")));

export const prepareFailureReason = (error: {
  readonly _tag: string;
  readonly message: string;
  readonly command?: string;
  readonly operation?: string;
}) => {
  if (error._tag === "GitError" && error.command) return `git ${error.command}: ${error.message}`;
  if (error._tag === "WorktreeFsError" && error.operation) {
    return `${error.operation}: ${error.message}`;
  }
  return error.message;
};

export const agentFailureReason = (text: string, kind: "blocked" | "missing-sentinel") => {
  const cleaned = truncate(stripResultLines(text));
  if (kind === "blocked") return cleaned || "agent reported blocked";
  return cleaned ? `agent produced no result line — ${cleaned}` : "agent produced no result line";
};

const headline = (stage: LifecycleStage, cause: BlockCause) => {
  if (cause.kind === "exhausted") {
    return `**Blocked after ${cause.attempts} failed ${stage} ${attemptWord(cause.attempts)}.**`;
  }
  return `**Blocked: ${stage} hit a non-retryable failure.**`;
};

export const blockedComment = (
  stage: LifecycleStage,
  cause: BlockCause,
  reason: string,
  resume: string | undefined,
) => {
  const lines = [
    attribution,
    "",
    headline(stage, cause),
    "",
    "Applied `ready-for-human`; a human needs to take over.",
    "",
    `Last failure: ${truncate(reason.replace(markerNoise, ""))}`,
  ];
  return resume === undefined
    ? lines.join("\n")
    : [...lines, "", "Resume the session manually:", "", "```sh", resume, "```"].join("\n");
};
