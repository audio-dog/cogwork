import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@cogwork/ui/components/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@cogwork/ui/components/collapsible";
import { Separator } from "@cogwork/ui/components/separator";
import { cn } from "@cogwork/ui/lib/utils";
import type { ReactNode } from "react";

import { relativeTime } from "../features/format";
import { useNow } from "../features/use-now";
import type { CatalogIcon } from "../features/workflow-catalog";
import type { SourceRef } from "../features/workflow-parks";
import { useAttention } from "./attention-board-context";
import { catalogIconFor } from "./workflow-catalog-menu";

const scrollIntoView = (node: HTMLElement | null) => node?.scrollIntoView({ block: "nearest" });

export function CatalogGlyph({ app }: { app: CatalogIcon }) {
  const Icon = catalogIconFor(app);
  return <Icon />;
}

export function AppIcon({ app }: { app: CatalogIcon }) {
  const Icon = catalogIconFor(app);
  return <Icon className="size-3.5 shrink-0 text-muted-foreground" />;
}

export function RelativeTime({ atMillis }: { atMillis: number }) {
  const now = useNow(60_000);
  return (
    <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{relativeTime(atMillis, now)}</span>
  );
}

const trackerApps: ReadonlySet<CatalogIcon> = new Set(["github", "linear"]);

export function SourceLabel({ source }: { source: SourceRef }) {
  return <span className={cn("truncate", trackerApps.has(source.app) && "font-mono")}>{source.label}</span>;
}

function AttentionCardRoot({ id, children }: { id: string; children: ReactNode }) {
  const {
    state: { focus },
    actions: { setFocus },
  } = useAttention();
  const open = focus === id;
  return (
    <Card size="sm" className="gap-0 py-0" ref={open ? scrollIntoView : undefined}>
      <Collapsible open={open} onOpenChange={(next) => setFocus(next ? id : null)}>
        {children}
      </Collapsible>
    </Card>
  );
}

function AttentionCardSummary({ children }: { children: ReactNode }) {
  return (
    <CollapsibleTrigger
      nativeButton={false}
      render={<CardHeader />}
      className="w-full py-3 text-start outline-none focus-visible:bg-muted/50"
    >
      {children}
    </CollapsibleTrigger>
  );
}

function AttentionCardTitle({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <CardTitle className="flex items-start gap-2.5">
      <span className="flex h-5 items-center">{icon}</span>
      {children}
    </CardTitle>
  );
}

function AttentionCardDescription({ children }: { children: ReactNode }) {
  return <CardDescription className="line-clamp-2 ps-6.5">{children}</CardDescription>;
}

function AttentionCardMeta({ children }: { children: ReactNode }) {
  return (
    <div className="mt-1 flex min-w-0 items-center gap-1.5 ps-6.5 text-xs text-muted-foreground">
      {children}
    </div>
  );
}

function AttentionCardDetail({ children }: { children: ReactNode }) {
  return (
    <CollapsibleContent>
      <CardContent className="flex flex-col gap-3 pb-3">
        <Separator />
        {children}
      </CardContent>
    </CollapsibleContent>
  );
}

export const AttentionCard = {
  Root: AttentionCardRoot,
  Summary: AttentionCardSummary,
  Title: AttentionCardTitle,
  Description: AttentionCardDescription,
  Meta: AttentionCardMeta,
  Detail: AttentionCardDetail,
};
