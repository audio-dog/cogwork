import { createFileRoute } from "@tanstack/react-router";
import { GeneralSettings } from "../../components/settings-general";

export const Route = createFileRoute("/settings/general")({
  component: GeneralSettings,
});
