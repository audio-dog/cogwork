import { createContext, type ReactNode, use, useMemo, useState } from "react";
import { toggle } from "../features/customize-places";
import { useConfiguration } from "./configuration-provider";

interface CustomizeFilterState {
  readonly places: readonly string[];
  readonly query: string;
}

interface CustomizeFilterActions {
  readonly setQuery: (query: string) => void;
  readonly togglePlace: (key: string) => void;
  readonly setPlaces: (places: readonly string[]) => void;
}

interface CustomizeFilterContextValue {
  readonly state: CustomizeFilterState;
  readonly actions: CustomizeFilterActions;
}

const CustomizeFilterContext = createContext<CustomizeFilterContextValue | null>(null);

export function useCustomizeFilter() {
  const value = use(CustomizeFilterContext);
  if (!value) throw new Error("Customize filter parts must render inside CustomizeFilterProvider");
  return value;
}

/**
 * Mounted on the Customize layout route, so the Place filter and the search text survive a drill-in
 * to a Plugin and back. Neither is in the URL: the Facet is the route, these two are not.
 */
export function CustomizeFilterProvider({ children }: { children: ReactNode }) {
  const {
    meta: { places: placeAxis },
  } = useConfiguration();
  const [places, setPlaces] = useState<readonly string[]>(placeAxis.allPlaceKeys);
  const [query, setQuery] = useState("");

  const value = useMemo<CustomizeFilterContextValue>(
    () => ({
      state: { places, query },
      actions: {
        setQuery,
        setPlaces,
        togglePlace: (key) => setPlaces((current) => toggle(current, key)),
      },
    }),
    [places, query],
  );

  return <CustomizeFilterContext value={value}>{children}</CustomizeFilterContext>;
}
