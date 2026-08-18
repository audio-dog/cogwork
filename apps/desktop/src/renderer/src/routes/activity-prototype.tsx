// PROTOTYPE — throwaway route for the Activity tab two-zone layout prototype
// (wayfinder ticket #27). Variants switch via ?variant= / ?full= and the
// floating bar; data is real (useActivityFeed → useLiveEvents/useBoard). Delete
// this route with activity-variants.tsx, activity-log.ts and
// prototype-switcher.tsx once a layout wins.

import { createFileRoute } from "@tanstack/react-router";
import { ActivityStage, type VariantKey, variantMeta } from "../components/activity-variants";
import { PrototypeSwitcher } from "../components/prototype-switcher";

interface ActivitySearch {
  readonly variant?: VariantKey;
  readonly full?: boolean;
}

const variantKeys = variantMeta.map((v) => v.key);

function ActivityPrototypePage() {
  const { variant, full } = Route.useSearch();
  const navigate = Route.useNavigate();
  const activeVariant: VariantKey = variant ?? "a";
  const isFull = full ?? false;

  return (
    <div className="h-full">
      <ActivityStage variant={activeVariant} full={isFull} />
      <PrototypeSwitcher
        variants={variantMeta}
        current={activeVariant}
        onSelect={(key) => navigate({ search: (prev) => ({ ...prev, variant: key }), replace: true })}
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
    const full = search.full === true || search.full === "true" ? true : undefined;
    return {
      ...(variant ? { variant } : {}),
      ...(full ? { full } : {}),
    };
  },
  component: ActivityPrototypePage,
});
