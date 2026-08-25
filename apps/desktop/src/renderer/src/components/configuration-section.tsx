// PROTOTYPE — dispatches a configuration section to the active variant's answer for it.
//
// A section can be absent from a variant: "one surface or two" is part of what #131 decides, so
// Variant A has no Customize section at all and Variant B has no Workflows one. Reaching an absent
// section says so rather than rendering an empty page.

import { Alert, AlertDescription, AlertTitle } from "@cogwork/ui/components/alert";
import { RiInformationLine } from "@remixicon/react";
import { findVariant } from "../features/configuration-variants";
import { useVariantKey } from "../features/use-variant";
import { PluginsPanel } from "./configuration-plugins-panel";
import { ConfigurationVariantA } from "./configuration-variant-a";
import { ConfigurationVariantB } from "./configuration-variant-b";
import { ConfigurationVariantC } from "./configuration-variant-c";
import { WorkspacesPanel } from "./configuration-workspaces-panel";

function AbsentSection({ sectionId, variantName }: { sectionId: string; variantName: string }) {
  return (
    <Alert>
      <RiInformationLine />
      <AlertTitle>
        Variant {variantName} has no {sectionId} section.
      </AlertTitle>
      <AlertDescription>
        Whether this is its own surface is one of the things these variants disagree about. Use the switcher
        at the bottom of the window, or the arrow keys, to move to a variant that has it.
      </AlertDescription>
    </Alert>
  );
}

/** The active variant's own label for a section, when it has one. Drives the page heading. */
export function useSectionLabel(sectionId: string): string | undefined {
  const variant = findVariant(useVariantKey());
  return variant.sections.find((section) => section.id === sectionId)?.label;
}

export function ConfigurationSection({ sectionId }: { sectionId: string }) {
  const variantKey = useVariantKey();
  const variant = findVariant(variantKey);

  if (sectionId === "workspaces") return <WorkspacesPanel />;

  if (!variant.sections.some((section) => section.id === sectionId)) {
    return <AbsentSection sectionId={sectionId} variantName={`${variant.key} — ${variant.name}`} />;
  }

  // Variant A fuses Plugins into the facet bar, so its `plugins` section is the whole surface.
  if (sectionId === "plugins") {
    return variantKey === "A" ? <ConfigurationVariantA /> : <PluginsPanel />;
  }

  if (sectionId === "customize") return <ConfigurationVariantB />;
  if (sectionId === "workflows") return <ConfigurationVariantC />;

  return null;
}
