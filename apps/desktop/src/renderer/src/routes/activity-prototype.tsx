// PROTOTYPE — throwaway route for the Activity tab two-zone layout prototype
// (wayfinder ticket #27). Variants switch via ?variant= / ?scenario= / ?full=
// and the floating bar; the Live scenario is real (useActivityFeed →
// useLiveEvents/useBoard), the others are DEV-only mock seeds so the layouts
// can be judged while the engine is off. Delete this route with
// activity-variants.tsx, activity-log.ts and prototype-switcher.tsx once a
// layout wins.

import { createFileRoute } from "@tanstack/react-router";
import {
  ActivityStage,
  type ScenarioKey,
  scenarioMeta,
  type VariantKey,
  variantMeta,
} from "../components/activity-variants";
import { PrototypeSwitcher } from "../components/prototype-switcher";

interface ActivitySearch {
  readonly variant?: VariantKey;
  readonly scenario?: ScenarioKey;
  readonly full?: boolean;
}

const variantKeys = variantMeta.map((v) => v.key);
const scenarioKeys = scenarioMeta.map((s) => s.key);

function ActivityPrototypePage() {
  const { variant, scenario, full } = Route.useSearch();
  const navigate = Route.useNavigate();
  const activeVariant: VariantKey = variant ?? "a";
  const activeScenario: ScenarioKey = scenario ?? "busy";
  const isFull = full ?? false;

  return (
    <div className="h-full">
      <ActivityStage variant={activeVariant} scenario={activeScenario} full={isFull} />
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

export const Route = createFileRoute("/activity-prototype")({
  validateSearch: (search: Record<string, unknown>): ActivitySearch => {
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
  component: ActivityPrototypePage,
});
