import { RiEqualizerLine } from "@remixicon/react";
import { createFileRoute } from "@tanstack/react-router";
import { CustomizeVariantA } from "../../components/customize-variant-a";
import { CustomizeVariantB } from "../../components/customize-variant-b";
import { CustomizeVariantC } from "../../components/customize-variant-c";
import { CustomizeVariantD } from "../../components/customize-variant-d";
import { CustomizeVariantE } from "../../components/customize-variant-e";
import { PrototypeSwitcher } from "../../components/prototype-switcher";
import { defaultVariant, isVariantKey, type VariantKey } from "../../features/configuration-variants";

interface CustomizeSearch {
  /** PROTOTYPE — selects a #131 variant. Goes away with the losing variants. */
  readonly variant?: VariantKey;
}

export const Route = createFileRoute("/_app/customize")({
  validateSearch: (search: Record<string, unknown>): CustomizeSearch => ({
    variant: isVariantKey(search.variant) ? search.variant : undefined,
  }),
  component: CustomizePage,
});

const bodyByVariant: Record<VariantKey, () => React.ReactNode> = {
  A: () => <CustomizeVariantA />,
  B: () => <CustomizeVariantB />,
  C: () => <CustomizeVariantC />,
  D: () => <CustomizeVariantD />,
  E: () => <CustomizeVariantE />,
};

function CustomizePage() {
  const { variant } = Route.useSearch();
  const key = variant ?? defaultVariant;
  return (
    <>
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-8 pt-6 pb-24">
        <div className="flex items-center gap-2">
          <RiEqualizerLine />
          <h1 className="font-heading text-2xl font-semibold tracking-tight">Customize</h1>
        </div>
        {bodyByVariant[key]()}
      </div>
      <PrototypeSwitcher />
    </>
  );
}
