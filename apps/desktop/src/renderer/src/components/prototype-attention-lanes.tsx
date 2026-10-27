import { Badge } from "@cogwork/ui/components/badge";
import { cn } from "@cogwork/ui/lib/utils";
import type { ReactNode } from "react";
import { useAttentionView } from "./prototype-attention-parts";

/** PROTOTYPE — issue #794. Lanes side by side on the board, stacked in the list. */

export function Lanes({ children }: { children: ReactNode }) {
  const { layout } = useAttentionView();
  return (
    <div
      className={cn(
        layout === "board" && "grid grid-cols-3 items-start gap-2",
        layout === "list" && "mx-auto flex w-full max-w-3xl flex-col gap-3",
      )}
    >
      {children}
    </div>
  );
}

export function Lane({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  const { layout } = useAttentionView();
  return (
    <section className="flex flex-col gap-1 rounded-2xl bg-muted/60 p-1">
      <h2
        className={cn(
          "flex h-8 items-center gap-2 px-2.5 text-[11px] font-medium tracking-wider text-muted-foreground uppercase",
          layout === "board" && "justify-center",
        )}
      >
        {title}
        <Badge variant="secondary" className="tabular-nums">
          {count}
        </Badge>
      </h2>
      <div className="flex flex-col gap-1.5">{children}</div>
    </section>
  );
}
