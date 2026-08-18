// PROTOTYPE — throwaway route for the Attention tab card-anatomy / list-treatment
// prototype (wayfinder ticket #26). Variants switch via ?variant= / ?full= and
// the floating bar; data is real (useBoard). Delete this route with
// attention-variants.tsx and prototype-switcher.tsx once a treatment wins.

import { createFileRoute } from "@tanstack/react-router";
import {
  AttentionStage,
  type ScenarioKey,
  scenarioMeta,
  type VariantKey,
  variantMeta,
} from "../components/attention-variants";
import { PrototypeSwitcher } from "../components/prototype-switcher";

interface AttentionSearch {
  readonly variant?: VariantKey;
  readonly scenario?: ScenarioKey;
  readonly full?: boolean;
}

const variantKeys = variantMeta.map((v) => v.key);
const scenarioKeys = scenarioMeta.map((s) => s.key);

function AttentionPrototypePage() {
  const { variant, scenario, full } = Route.useSearch();
  const navigate = Route.useNavigate();
  const activeVariant: VariantKey = variant ?? "a";
  const activeScenario: ScenarioKey = scenario ?? "busy";
  const isFull = full ?? false;

  return (
    <div className="h-full">
      <AttentionStage variant={activeVariant} scenario={activeScenario} full={isFull} />
      <PrototypeSwitcher
        variants={variantMeta}
        current={activeVariant}
        onSelect={(key) => navigate({ search: (prev) => ({ ...prev, variant: key }), replace: true })}
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

export const Route = createFileRoute("/attention-prototype")({
  validateSearch: (search: Record<string, unknown>): AttentionSearch => {
    const variant = variantKeys.includes(search.variant as VariantKey)
      ? (search.variant as VariantKey)
      : undefined;
    const scenario = scenarioKeys.includes(search.scenario as ScenarioKey)
      ? (search.scenario as ScenarioKey)
      : undefined;
    const full = search.full === true || search.full === "true" ? true : undefined;
    return {
      ...(variant ? { variant } : {}),
      ...(scenario ? { scenario } : {}),
      ...(full ? { full } : {}),
    };
  },
  component: AttentionPrototypePage,
});
