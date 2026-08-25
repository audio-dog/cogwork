import { ScrollArea } from "@cogwork/ui/components/scroll-area";
import { SidebarInset } from "@cogwork/ui/components/sidebar";
import { cn } from "@cogwork/ui/lib/utils";
import { createFileRoute, Outlet } from "@tanstack/react-router";
import { PrototypeSwitcher } from "../../components/prototype-switcher";
import { SettingsSidebar } from "../../components/settings-sidebar";
import { isConfigurationSection } from "../../features/settings-catalog";
import { useActiveSectionId } from "../../features/use-settings-route";

export const Route = createFileRoute("/settings")({
  component: SettingsShell,
});

function SettingsShell() {
  const sectionId = useActiveSectionId();
  // The configuration surfaces carry rows, badges and provenance side by side; the app's own
  // settings are a single column of switches and stay narrow.
  const wide = isConfigurationSection(sectionId);
  return (
    <>
      <SettingsSidebar />
      <SidebarInset className="h-svh overflow-hidden">
        <div className="flex h-full min-h-0 flex-col">
          <div className="h-11 shrink-0 [-webkit-app-region:drag]" />
          <ScrollArea className="min-h-0 flex-1">
            <div className={cn("mx-auto w-full px-8 pt-2 pb-24", wide ? "max-w-5xl" : "max-w-2xl")}>
              <Outlet />
            </div>
          </ScrollArea>
        </div>
      </SidebarInset>
      {wide ? <PrototypeSwitcher /> : null}
    </>
  );
}
