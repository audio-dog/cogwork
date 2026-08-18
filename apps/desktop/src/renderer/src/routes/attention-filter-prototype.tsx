// PROTOTYPE — throwaway route for the Attention tab FILTERING UI prototype
// (wayfinder #26, second round; the flat-list layout B is already chosen).
// Treatments switch via ?treatment= / ?scenario= / ?full= and the floating bar.
// Delete with attention-filter-variants.tsx once a filter UI wins.

import { createFileRoute } from "@tanstack/react-router";
import {
  AttentionFilterStage,
  type FilterTreatmentKey,
  filterMeta,
} from "../components/attention-filter-variants";
import { type ScenarioKey, scenarioMeta } from "../components/attention-variants";
import { PrototypeSwitcher } from "../components/prototype-switcher";

interface FilterSearch {
  readonly treatment?: FilterTreatmentKey;
  readonly scenario?: ScenarioKey;
  readonly full?: boolean;
}

const treatmentKeys = filterMeta.map((t) => t.key);
const scenarioKeys = scenarioMeta.map((s) => s.key);

function AttentionFilterPrototypePage() {
  const { treatment, scenario, full } = Route.useSearch();
  const navigate = Route.useNavigate();
  const activeTreatment: FilterTreatmentKey = treatment ?? "g1";
  const activeScenario: ScenarioKey = scenario ?? "busy";
  const isFull = full ?? false;

  return (
    <div className="h-full">
      <AttentionFilterStage treatment={activeTreatment} scenario={activeScenario} full={isFull} />
      <PrototypeSwitcher
        variants={filterMeta}
        current={activeTreatment}
        onSelect={(key) => navigate({ search: (prev) => ({ ...prev, treatment: key }), replace: true })}
        secondary={{
          label: "Data",
          variants: scenarioMeta,
          current: activeScenario,
          onSelect: (key) => navigate({ search: (prev) => ({ ...prev, scenario: key }), replace: true }),
        }}
        toggle={{
          label: "Full width",
          on: isFull,
          onToggle: () => navigate({ search: (prev) => ({ ...prev, full: !isFull }), replace: true }),
        }}
      />
    </div>
  );
}

export const Route = createFileRoute("/attention-filter-prototype")({
  validateSearch: (search: Record<string, unknown>): FilterSearch => {
    const treatment = treatmentKeys.includes(search.treatment as FilterTreatmentKey)
      ? (search.treatment as FilterTreatmentKey)
      : undefined;
    const scenario = scenarioKeys.includes(search.scenario as ScenarioKey)
      ? (search.scenario as ScenarioKey)
      : undefined;
    const full = search.full === true || search.full === "true" ? true : undefined;
    return {
      ...(treatment ? { treatment } : {}),
      ...(scenario ? { scenario } : {}),
      ...(full ? { full } : {}),
    };
  },
  component: AttentionFilterPrototypePage,
});
