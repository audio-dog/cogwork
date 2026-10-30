import { hasCogworkMarker } from "./markers";
import type { BotAllowlist } from "./source-control-target";

export interface GitHubFeedback {
  readonly authorLogin: string;
  readonly body: string;
  readonly inReplyToId?: number | null;
  readonly subjectType?: "line" | "file";
}

export const trustedBotFeedback = <A extends GitHubFeedback>(
  feedback: ReadonlyArray<A>,
  allowlist: BotAllowlist,
) =>
  feedback.filter((item) => {
    const mode = allowlist.get(item.authorLogin);
    if (!mode || hasCogworkMarker(item.body)) return false;
    return mode.acceptsAnyComment || (item.inReplyToId === null && item.subjectType === "line");
  });
