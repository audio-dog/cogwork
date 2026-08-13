import type { ClassifiedItem } from "@cogwork/contracts";
import { Badge } from "@cogwork/ui/components/badge";
import type { FeedItem } from "../features/feed";

export function ItemBadges({ item }: { item: ClassifiedItem }) {
  return (
    <>
      {item._tag === "NeedsHuman" && <Badge variant="outline">needs human</Badge>}
      {item._tag === "Blocked" && <Badge variant="outline">blocked</Badge>}
      {item.pr && <Badge variant="secondary">PR #{item.pr.number}</Badge>}
    </>
  );
}

export function LaneMiniCard({ entry, running }: { entry: FeedItem; running?: boolean }) {
  const { item } = entry;
  return (
    <div className={`mb-1.5 w-[194px] rounded-lg border bg-card p-2 ${running ? "border-primary/40" : ""}`}>
      <div className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
        {item.id}
        {running && <span className="size-1.5 animate-pulse rounded-full bg-primary" />}
      </div>
      <p className="mt-0.5 text-xs leading-snug">{item.title}</p>
      <div className="mt-1.5">
        <ItemBadges item={item} />
      </div>
    </div>
  );
}
