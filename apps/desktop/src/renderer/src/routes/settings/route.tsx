import { ScrollArea } from "@cogwork/ui/components/scroll-area";
import { SidebarInset } from "@cogwork/ui/components/sidebar";
import { createFileRoute, Outlet } from "@tanstack/react-router";

import { SettingsFocusProvider } from "../../components/settings-parts";
import { SettingsSidebar } from "../../components/settings-sidebar";

export interface SettingsSearch {
  readonly focus?: string;
  readonly jump?: number;
}

export const Route = createFileRoute("/settings")({
  // `focus` and `jump` mean the same thing in every section, so they are validated once here and
  // inherited rather than repeated on each one.
  validateSearch: (search: Record<string, unknown>): SettingsSearch => ({
    focus: typeof search.focus === "string" ? search.focus : undefined,
    jump: typeof search.jump === "number" ? search.jump : undefined,
  }),
  component: SettingsShell,
});

function SettingsShell() {
  const { focus, jump } = Route.useSearch();
  return (
    <>
      <SettingsSidebar />
      <SidebarInset className="h-svh overflow-hidden">
        <div className="flex h-full min-h-0 flex-col">
          <div className="h-11 shrink-0 [-webkit-app-region:drag]" />
          <ScrollArea className="min-h-0 flex-1">
            <div className="mx-auto w-full max-w-2xl px-8 pt-2 pb-12">
              <SettingsFocusProvider focus={focus} jump={jump}>
                <Outlet />
              </SettingsFocusProvider>
            </div>
          </ScrollArea>
        </div>
      </SidebarInset>
    </>
  );
}
