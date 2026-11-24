import { useMatchRoute } from "@tanstack/react-router";

import { settingsSections } from "./settings-catalog";

/** Which section the router is showing. The route decides; nothing parses the path by hand. */
export function useActiveSection() {
  const matchRoute = useMatchRoute();
  return settingsSections.find((section) => matchRoute({ to: section.link.to }));
}
