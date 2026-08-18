import { Button } from "@cogwork/ui/components/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@cogwork/ui/components/command";
import { Sidebar, SidebarContent, SidebarGroup, SidebarHeader } from "@cogwork/ui/components/sidebar";
import { cn } from "@cogwork/ui/lib/utils";
import { RiArrowLeftLine } from "@remixicon/react";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { findSection, searchSettings, settingsSections } from "../features/settings-catalog";
import { useActiveSectionId } from "../features/use-settings-route";

function SettingsSidebarHeader() {
  const navigate = useNavigate();
  return (
    <SidebarHeader className="h-11 shrink-0 flex-row items-center gap-1 px-3 py-0 [-webkit-app-region:drag]">
      <div className="ml-[var(--workspace-titlebar-content-left)] flex items-center gap-1 [-webkit-app-region:no-drag]">
        <Button aria-label="Back to app" size="icon-sm" variant="ghost" onClick={() => navigate({ to: "/" })}>
          <RiArrowLeftLine />
        </Button>
        <span className="text-sm font-semibold">Settings</span>
      </div>
    </SidebarHeader>
  );
}

function SectionList({ activeSectionId, onNavigate }: { activeSectionId: string; onNavigate: () => void }) {
  const navigate = useNavigate();
  return (
    <CommandGroup>
      {settingsSections.map((section) => (
        <CommandItem
          key={section.id}
          value={section.id}
          className={cn(activeSectionId === section.id && "bg-muted font-medium text-foreground")}
          onSelect={() => {
            onNavigate();
            navigate({ to: "/settings/$section", params: { section: section.id } });
          }}
        >
          <section.icon />
          <span>{section.label}</span>
        </CommandItem>
      ))}
    </CommandGroup>
  );
}

function SearchResults({ query, onNavigate }: { query: string; onNavigate: () => void }) {
  const navigate = useNavigate();
  const results = searchSettings(query);
  return (
    <CommandGroup>
      {results.map((entry) => (
        <CommandItem
          key={entry.id}
          value={entry.id}
          onSelect={() => {
            onNavigate();
            navigate({
              to: "/settings/$section",
              params: { section: entry.sectionId },
              search: { focus: entry.id },
            });
          }}
        >
          <div className="flex min-w-0 flex-col">
            <span className="truncate">{entry.title}</span>
            <span className="truncate text-xs text-muted-foreground">
              {findSection(entry.sectionId)?.label}
            </span>
          </div>
        </CommandItem>
      ))}
    </CommandGroup>
  );
}

export function SettingsSidebar() {
  const [query, setQuery] = useState("");
  const activeSectionId = useActiveSectionId();
  const searching = query.trim() !== "";
  const clearQuery = () => setQuery("");

  return (
    <Sidebar collapsible="offcanvas">
      <SettingsSidebarHeader />
      <SidebarContent>
        <SidebarGroup className="min-h-0 flex-1 p-2">
          <Command shouldFilter={false} className="bg-transparent" loop>
            <CommandInput value={query} onValueChange={setQuery} placeholder="Search settings…" />
            <CommandList className="mt-1 max-h-none">
              <CommandEmpty>No matching settings.</CommandEmpty>
              {searching ? (
                <SearchResults query={query} onNavigate={clearQuery} />
              ) : (
                <SectionList activeSectionId={activeSectionId} onNavigate={clearQuery} />
              )}
            </CommandList>
          </Command>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  );
}
