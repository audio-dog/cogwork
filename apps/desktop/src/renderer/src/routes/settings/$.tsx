import { createFileRoute, redirect } from "@tanstack/react-router";

/** Keeps the old behaviour: an unknown section lands on General rather than a not-found page. */
export const Route = createFileRoute("/settings/$")({
  beforeLoad: () => {
    throw redirect({ to: "/settings/general" });
  },
});
