import type { PrSummary } from "@cogwork/contracts";
import { Button } from "@cogwork/ui/components/button";
import { RiExternalLinkLine } from "@remixicon/react";
import { relativeTime } from "../features/format";
import { PrChecksBadge, PrDivergenceBadge, PrReviewBadge } from "./badges";

export function PullRequest({ pr, now }: { pr: PrSummary; now: number }) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span>PR #{pr.number}</span>
        <span aria-hidden>·</span>
        <span>waiting {relativeTime(pr.waitingSinceMillis, now)}</span>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <PrChecksBadge checks={pr.checks} />
        <PrReviewBadge review={pr.review} />
        <PrDivergenceBadge divergence={pr.baseDivergence} />
      </div>
      <p className="text-xs text-muted-foreground">Review and merge happen on GitHub.</p>
      <Button
        size="sm"
        variant="outline"
        className="w-fit"
        render={<a href={pr.url} rel="noreferrer" target="_blank" />}
      >
        Open on GitHub
        <RiExternalLinkLine data-icon="inline-end" />
      </Button>
    </section>
  );
}
