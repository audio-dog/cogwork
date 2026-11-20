import type { PrChecks, PrSummary } from "@cogwork/contracts";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@cogwork/ui/components/collapsible";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@cogwork/ui/components/item";
import { Separator } from "@cogwork/ui/components/separator";
import { cn } from "@cogwork/ui/lib/utils";
import type { RemixiconComponentType } from "@remixicon/react";
import {
  RiArrowRightSLine,
  RiCheckboxCircleLine,
  RiCloseCircleLine,
  RiGitBranchLine,
  RiGitPullRequestLine,
  RiQuestionAnswerLine,
  RiTimeLine,
} from "@remixicon/react";
import type { ReactNode } from "react";

import { relativeTime } from "../features/format";
import { PrChecksBadge, PrDivergenceBadge, PrReviewBadge } from "./badges";

const checksIcon: Record<PrChecks, RemixiconComponentType> = {
  passing: RiCheckboxCircleLine,
  failing: RiCloseCircleLine,
  pending: RiTimeLine,
};

function PullRequestSection({
  children,
  defaultOpen = false,
  title,
}: {
  children: ReactNode;
  defaultOpen?: boolean;
  title: ReactNode;
}) {
  return (
    <Collapsible defaultOpen={defaultOpen}>
      <CollapsibleTrigger className="group/trigger flex w-full items-center justify-between gap-3 py-4 text-left text-sm font-medium [&_svg]:size-4">
        {title}
        <RiArrowRightSLine
          aria-hidden
          className="transition-transform group-data-[panel-open]/trigger:rotate-90"
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="pb-4">{children}</CollapsibleContent>
    </Collapsible>
  );
}

export function PullRequest({ pr, now, title }: { pr: PrSummary; now: number; title: string }) {
  const waiting = relativeTime(pr.waitingSinceMillis, now);
  const ChecksIcon = checksIcon[pr.checks];

  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-1.5">
          <h2 className="w-fit text-lg font-semibold [&>a]:underline-offset-4 [&>a:hover]:underline">
            <a href={pr.url} rel="noreferrer" target="_blank">
              {title}
            </a>
          </h2>
          <p className="text-xs text-muted-foreground">
            PR #{pr.number} · waiting {waiting}
          </p>
        </div>
        <div className="grid grid-cols-[1rem_5.5rem_minmax(0,1fr)] items-center gap-x-3 gap-y-3 text-xs [&_svg]:size-4">
          <RiCheckboxCircleLine aria-hidden className="text-muted-foreground" />
          <span className="text-muted-foreground">Checks</span>
          <PrChecksBadge checks={pr.checks} />

          <RiQuestionAnswerLine aria-hidden className="text-muted-foreground" />
          <span className="text-muted-foreground">Review</span>
          <PrReviewBadge review={pr.review} />

          <RiGitBranchLine aria-hidden className="text-muted-foreground" />
          <span className="text-muted-foreground">Base</span>
          <div className="flex items-center">
            {pr.baseDivergence === "none" ? (
              <span>Up to date</span>
            ) : (
              <PrDivergenceBadge divergence={pr.baseDivergence} />
            )}
          </div>

          <RiTimeLine aria-hidden className="text-muted-foreground" />
          <span className="text-muted-foreground">Waiting</span>
          <span>{waiting}</span>
        </div>
      </div>
      <div>
        <PullRequestSection title="Description">
          <p className="px-1 text-xs text-muted-foreground">No description is available yet.</p>
        </PullRequestSection>
        <Separator />
        <PullRequestSection defaultOpen title="Checks">
          <Item size="sm" variant="outline">
            <ItemMedia variant="icon">
              <ChecksIcon
                aria-hidden
                className={cn(
                  "text-muted-foreground",
                  pr.checks === "passing" && "text-primary",
                  pr.checks === "failing" && "text-destructive",
                )}
              />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>Code host checks</ItemTitle>
              <ItemDescription>Required validation</ItemDescription>
            </ItemContent>
            <ItemActions>
              <PrChecksBadge checks={pr.checks} />
            </ItemActions>
          </Item>
        </PullRequestSection>
        <Separator />
        <PullRequestSection
          defaultOpen
          title={
            <span className="flex items-center gap-2">
              Activity
              <span className="font-normal text-muted-foreground">1</span>
            </span>
          }
        >
          <Collapsible defaultOpen>
            <div className="overflow-hidden rounded-lg border">
              <CollapsibleTrigger className="group/trigger flex w-full items-center justify-between gap-3 px-3 py-3 text-left text-xs [&_svg]:size-4">
                <span className="flex min-w-0 items-center gap-2 font-medium">
                  <RiGitPullRequestLine aria-hidden className="text-muted-foreground" />
                  Current status
                </span>
                <span className="flex shrink-0 items-center gap-2 text-muted-foreground">
                  {waiting}
                  <RiArrowRightSLine
                    aria-hidden
                    className="transition-transform group-data-[panel-open]/trigger:rotate-90"
                  />
                </span>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <Separator />
                <div className="flex flex-col gap-3 px-3 py-3">
                  <div className="flex items-center justify-between gap-3 text-xs">
                    <span className="text-muted-foreground">Checks</span>
                    <PrChecksBadge checks={pr.checks} />
                  </div>
                  <div className="flex items-center justify-between gap-3 text-xs">
                    <span className="text-muted-foreground">Review</span>
                    <PrReviewBadge review={pr.review} />
                  </div>
                  {pr.baseDivergence !== "none" && (
                    <div className="flex items-center justify-between gap-3 text-xs">
                      <span className="text-muted-foreground">Base</span>
                      <PrDivergenceBadge divergence={pr.baseDivergence} />
                    </div>
                  )}
                </div>
              </CollapsibleContent>
            </div>
          </Collapsible>
        </PullRequestSection>
      </div>
    </section>
  );
}
