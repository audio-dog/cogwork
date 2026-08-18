import { useRouterState } from "@tanstack/react-router";

export function useInSettings() {
  return useRouterState({
    select: (state) => state.location.pathname.startsWith("/settings"),
  });
}

export function useActiveSectionId() {
  return useRouterState({
    select: (state) => state.location.pathname.split("/")[2] ?? "",
  });
}
