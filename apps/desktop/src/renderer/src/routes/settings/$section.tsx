import { createFileRoute, redirect } from "@tanstack/react-router";
import { SettingsSectionView } from "../../components/settings-page";
import { isVariantKey, type VariantKey } from "../../features/configuration-variants";
import { isSettingsSectionId } from "../../features/settings-catalog";

interface SectionSearch {
  readonly focus?: string;
  readonly jump?: number;
  /** PROTOTYPE — selects a #131 variant. Goes away with the losing variants. */
  readonly variant?: VariantKey;
}

export const Route = createFileRoute("/settings/$section")({
  validateSearch: (search: Record<string, unknown>): SectionSearch => ({
    focus: typeof search.focus === "string" ? search.focus : undefined,
    jump: typeof search.jump === "number" ? search.jump : undefined,
    variant: isVariantKey(search.variant) ? search.variant : undefined,
  }),
  beforeLoad: ({ params }) => {
    if (!isSettingsSectionId(params.section)) {
      throw redirect({ to: "/settings/$section", params: { section: "general" } });
    }
  },
  component: SettingsSectionPage,
});

function SettingsSectionPage() {
  const { section } = Route.useParams();
  const { focus, jump } = Route.useSearch();
  if (!isSettingsSectionId(section)) return null;
  return <SettingsSectionView sectionId={section} focus={focus} jump={jump} />;
}
