import { createFileRoute } from "@tanstack/react-router";
import { OverviewScreen } from "../features/overview-screen";

export const Route = createFileRoute("/")({
  component: OverviewScreen,
});
