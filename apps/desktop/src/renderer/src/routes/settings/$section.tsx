import { createFileRoute, redirect } from "@tanstack/react-router";
import { SettingsSectionView } from "../../components/settings-page";
import { isSettingsSectionId } from "../../features/settings-catalog";

interface SectionSearch {
  readonly focus?: string;
  readonly jump?: number;
}

export const Route = createFileRoute("/settings/$section")({
  validateSearch: (search: Record<string, unknown>): SectionSearch => ({
    focus: typeof search.focus === "string" ? search.focus : undefined,
    jump: typeof search.jump === "number" ? search.jump : undefined,
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
