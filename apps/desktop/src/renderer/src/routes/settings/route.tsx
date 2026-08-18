import { ScrollArea } from "@cogwork/ui/components/scroll-area";
import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/settings")({
  component: SettingsLayout,
});

function SettingsLayout() {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="h-11 shrink-0 [-webkit-app-region:drag]" />
      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto w-full max-w-2xl px-8 pt-2 pb-12">
          <Outlet />
        </div>
      </ScrollArea>
    </div>
  );
}
