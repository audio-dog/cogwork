import { Button } from "@cogwork/ui/components/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@cogwork/ui/components/input-group";
import { Item, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "@cogwork/ui/components/item";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@cogwork/ui/components/sidebar";
import { TooltipProvider } from "@cogwork/ui/components/tooltip";
import { RiArrowLeftLine, RiCloseLine, RiSearchLine } from "@remixicon/react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import {
  findSection,
  type SettingEntry,
  type SettingsSection,
  searchSettings,
  settingsSections,
} from "../features/settings-catalog";
import { useActiveSection } from "../features/use-settings-route";

function SectionNav({ active }: { active?: SettingsSection }) {
  return (
    <SidebarMenu>
      {settingsSections.map((section) => (
        <SidebarMenuItem key={section.id}>
          <SidebarMenuButton
            isActive={section.id === active?.id}
            tooltip={section.label}
            render={<Link {...section.link} />}
          >
            <section.icon />
            <span>{section.label}</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      ))}
    </SidebarMenu>
  );
}

function SearchResult({ entry, onSelect }: { entry: SettingEntry; onSelect: () => void }) {
  const section = findSection(entry.sectionId);
  const Icon = section?.icon;
  return (
    <Item
      size="sm"
      render={<button type="button" onClick={onSelect} />}
      className="w-full cursor-pointer text-left hover:bg-sidebar-accent"
    >
      {Icon ? (
        <ItemMedia variant="icon">
          <Icon />
        </ItemMedia>
      ) : null}
      <ItemContent>
        <ItemTitle>{entry.title}</ItemTitle>
        <ItemDescription>{section?.label}</ItemDescription>
      </ItemContent>
    </Item>
  );
}

function SearchResults({ query, onSelect }: { query: string; onSelect: (entry: SettingEntry) => void }) {
  const results = searchSettings(query);
  if (results.length === 0) {
    return <p className="px-2 py-3 text-sm text-muted-foreground">No settings match.</p>;
  }
  return (
    <div className="flex flex-col gap-0.5">
      {results.map((entry) => (
        <SearchResult key={entry.id} entry={entry} onSelect={() => onSelect(entry)} />
      ))}
    </div>
  );
}

export function SettingsSidebar() {
  const navigate = useNavigate();
  const active = useActiveSection();
  const [query, setQuery] = useState("");
  const searching = query.trim() !== "";

  const openSetting = (entry: SettingEntry) => {
    const section = findSection(entry.sectionId);
    if (!section) return;
    setQuery("");
    navigate({ ...section.link, search: { focus: entry.id, jump: Date.now() } });
  };

  return (
    <TooltipProvider>
      {/* `SidebarProvider`'s wrapper is `min-h-svh`, so a `collapsible="none"` rail's own
          `h-full` has no definite height to resolve against. */}
      <Sidebar collapsible="none" className="h-svh">
        <SidebarHeader className="h-11 shrink-0 [-webkit-app-region:drag]" />
        <SidebarContent>
          <div className="flex flex-col gap-2 px-2">
            <Button
              variant="ghost"
              size="sm"
              className="w-fit justify-start [-webkit-app-region:no-drag]"
              onClick={() => navigate({ to: "/" })}
            >
              <RiArrowLeftLine data-icon="inline-start" />
              Back to app
            </Button>
            <InputGroup>
              <InputGroupInput
                placeholder="Search settings…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              <InputGroupAddon>
                <RiSearchLine />
              </InputGroupAddon>
              {searching ? (
                <InputGroupAddon align="inline-end">
                  <InputGroupButton size="icon-xs" aria-label="Clear search" onClick={() => setQuery("")}>
                    <RiCloseLine />
                  </InputGroupButton>
                </InputGroupAddon>
              ) : null}
            </InputGroup>
          </div>
          <SidebarGroup className="pt-2">
            {searching ? (
              <SearchResults query={query} onSelect={openSetting} />
            ) : (
              <SectionNav active={active} />
            )}
          </SidebarGroup>
        </SidebarContent>
      </Sidebar>
    </TooltipProvider>
  );
}
