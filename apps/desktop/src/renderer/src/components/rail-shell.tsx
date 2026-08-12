import { ScrollArea } from "@clanker-forge/ui/components/scroll-area";
import type { ReactNode } from "react";

export function RailShell({ header, children }: { header: ReactNode; children: ReactNode }) {
  return (
    <aside className="flex w-80 shrink-0 flex-col border-l">
      <div className="flex items-center gap-2 border-b px-4 py-3">{header}</div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="p-4">{children}</div>
      </ScrollArea>
    </aside>
  );
}
