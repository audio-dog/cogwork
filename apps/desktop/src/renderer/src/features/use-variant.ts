// PROTOTYPE — reads the active `?variant=` from the router.
//
// Route-agnostic on purpose: the switcher, the settings sidebar and the section view all need the
// same answer, and none of them should have to know which route it came from.

import { useRouterState } from "@tanstack/react-router";
import { defaultVariant, isVariantKey, type VariantKey } from "./configuration-variants";

export function useVariantKey(): VariantKey {
  return useRouterState({
    select: (state) => {
      const raw = (state.location.search as Record<string, unknown>).variant;
      return isVariantKey(raw) ? raw : defaultVariant;
    },
  });
}
