import { createFileRoute } from "@tanstack/react-router";
import { SchedulingSettings } from "../../components/settings-scheduling";

export const Route = createFileRoute("/settings/scheduling")({
  component: SchedulingSettings,
});
