import { ScrollArea } from "@cogwork/ui/components/scroll-area";
import type { ReactNode } from "react";

function RailShellFrame({ children }: { children: ReactNode }) {
  return <aside className="flex w-80 shrink-0 flex-col border-l">{children}</aside>;
}

function RailShellHeader({ children }: { children: ReactNode }) {
  return <div className="flex items-center gap-2 border-b px-4 py-3">{children}</div>;
}

function RailShellBody({ children }: { children: ReactNode }) {
  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="p-4">{children}</div>
    </ScrollArea>
  );
}

export const RailShell = {
  Frame: RailShellFrame,
  Header: RailShellHeader,
  Body: RailShellBody,
};
