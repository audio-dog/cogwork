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
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { findVariant } from "../features/configuration-variants";
import {
  findSection,
  isConfigurationSection,
  type SettingEntry,
  searchSettings,
  settingsSections,
} from "../features/settings-catalog";
import { useActiveSectionId } from "../features/use-settings-route";
import { useVariantKey } from "../features/use-variant";

/**
 * PROTOTYPE — the configuration sections come from the active variant, because whether Plugins and
 * Customize are one surface or two is part of what #131 decides. The app's own settings sections
 * are unaffected and sit below them.
 */
function SectionNav({ activeSectionId }: { activeSectionId: string }) {
  const navigate = useNavigate();
  const variantKey = useVariantKey();
  const variant = findVariant(variantKey);

  const appSections = settingsSections.filter((section) => !isConfigurationSection(section.id));
  const go = (section: string) =>
    navigate({ to: "/settings/$section", params: { section }, search: { variant: variantKey } });

  return (
    <div className="flex flex-col gap-4">
      <SidebarMenu>
        {variant.sections.map((section) => {
          const catalogEntry = findSection(section.id);
          const Icon = catalogEntry?.icon;
          return (
            <SidebarMenuItem key={section.id}>
              <SidebarMenuButton
                isActive={section.id === activeSectionId}
                tooltip={section.label}
                onClick={() => go(section.id)}
              >
                {Icon ? <Icon /> : null}
                <span>{section.label}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          );
        })}
      </SidebarMenu>
      <SidebarMenu>
        {appSections.map((section) => (
          <SidebarMenuItem key={section.id}>
            <SidebarMenuButton
              isActive={section.id === activeSectionId}
              tooltip={section.label}
              onClick={() => go(section.id)}
            >
              <section.icon />
              <span>{section.label}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        ))}
      </SidebarMenu>
    </div>
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
  const activeSectionId = useActiveSectionId();
  const variantKey = useVariantKey();
  const [query, setQuery] = useState("");
  const searching = query.trim() !== "";

  const openSetting = (entry: SettingEntry) => {
    setQuery("");
    navigate({
      to: "/settings/$section",
      params: { section: entry.sectionId },
      search: { focus: entry.id, jump: Date.now(), variant: variantKey },
    });
  };

  return (
    <TooltipProvider>
      <Sidebar collapsible="none">
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
              <SectionNav activeSectionId={activeSectionId} />
            )}
          </SidebarGroup>
        </SidebarContent>
      </Sidebar>
    </TooltipProvider>
  );
}
