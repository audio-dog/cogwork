// PROTOTYPE — throwaway route for the item detail tab layout prototype
// (wayfinder ticket #25). Variants switch via ?variant= / ?scenario= / ?full=
// and the floating bar. Delete this route with item-tab-variants.tsx and
// prototype-switcher.tsx once a layout shape wins.

import { createFileRoute } from "@tanstack/react-router";
import {
  ItemTabStage,
  type ScenarioKey,
  scenarios,
  type VariantKey,
  variantMeta,
} from "../components/item-tab-variants";
import { PrototypeSwitcher } from "../components/prototype-switcher";

interface ItemTabSearch {
  readonly variant?: VariantKey;
  readonly scenario?: ScenarioKey;
  readonly full?: boolean;
}

const variantKeys = variantMeta.map((v) => v.key);
const scenarioKeys = scenarios.map((s) => s.key);

function ItemTabPrototypePage() {
  const { variant, scenario, full } = Route.useSearch();
  const navigate = Route.useNavigate();
  const activeVariant: VariantKey = variant ?? "a";
  const activeScenario: ScenarioKey = scenario ?? "running";
  const isFull = full ?? false;

  return (
    <div className="h-full">
      <ItemTabStage variant={activeVariant} scenario={activeScenario} full={isFull} />
      <PrototypeSwitcher
        variants={variantMeta}
        current={activeVariant}
        onSelect={(key) => navigate({ search: (prev) => ({ ...prev, variant: key }), replace: true })}
        secondary={{
          label: "State",
          variants: scenarios,
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

export const Route = createFileRoute("/item-tab-prototype")({
  validateSearch: (search: Record<string, unknown>): ItemTabSearch => {
    const variant = variantKeys.includes(search.variant as VariantKey)
      ? (search.variant as VariantKey)
      : undefined;
    const scenario = scenarioKeys.includes(search.scenario as ScenarioKey)
      ? (search.scenario as ScenarioKey)
      : undefined;
    const full = search.full === true || search.full === "true" ? true : undefined;
    return { ...(variant ? { variant } : {}), ...(scenario ? { scenario } : {}), ...(full ? { full } : {}) };
  },
  component: ItemTabPrototypePage,
});
