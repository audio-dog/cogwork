import { createFileRoute } from "@tanstack/react-router";
import { EngineSettings } from "../../components/settings-engine";

export const Route = createFileRoute("/settings/engine")({
  component: EngineSettings,
});
