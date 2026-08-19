import { useRouterState } from "@tanstack/react-router";

export function useActiveSectionId() {
  return useRouterState({
    select: (state) => state.location.pathname.split("/")[2] ?? "",
  });
}
