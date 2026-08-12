import { Badge } from "@clanker-forge/ui/components/badge";
import { Button } from "@clanker-forge/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@clanker-forge/ui/components/card";
import { RiExternalLinkLine, RiGitPullRequestLine, RiQuestionAnswerLine } from "@remixicon/react";
import type { FeedItem, MergeGateItem } from "../features/feed";
import { relativeTime } from "../features/format";
import { PrChecksBadge } from "./badges";

const reasonLabel: Record<"needs-info" | "ready-for-human", string> = {
  "needs-info": "Needs info",
  "ready-for-human": "Ready for human",
};

export function SelfHaltCard({ entry }: { entry: FeedItem }) {
  const { item } = entry;
  if (item._tag !== "NeedsHuman") return null;
  return (
    <Card size="sm">
      <CardHeader>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <RiQuestionAnswerLine className="size-3.5" />
          <span>{entry.workspace}</span>
          <span aria-hidden>·</span>
          <span>{item.id}</span>
        </div>
        <CardTitle className="mt-1 text-sm">{item.title}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <Badge variant="outline">{reasonLabel[item.reason]}</Badge>
        {item.proposal ? (
          <p className="rounded-md bg-muted/50 p-2 text-xs text-muted-foreground whitespace-pre-wrap">
            {item.proposal}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground italic">No proposal recorded.</p>
        )}
      </CardContent>
    </Card>
  );
}

export function MergeGateCard({ entry }: { entry: MergeGateItem }) {
  const { item, pr } = entry;
  return (
    <Card size="sm">
      <CardHeader>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <RiGitPullRequestLine className="size-3.5" />
          <span>{entry.workspace}</span>
          <span aria-hidden>·</span>
          <span>#{pr.number}</span>
        </div>
        <CardTitle className="mt-1 text-sm">{item.title}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <PrChecksBadge checks={pr.checks} />
          {pr.baseDivergence === "conflict" && <Badge variant="destructive">Conflicts</Badge>}
        </div>
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground">waiting {relativeTime(pr.waitingSinceMillis)}</span>
          <Button size="xs" variant="ghost" render={<a href={pr.url} rel="noreferrer" target="_blank" />}>
            Open PR
            <RiExternalLinkLine data-icon="inline-end" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
