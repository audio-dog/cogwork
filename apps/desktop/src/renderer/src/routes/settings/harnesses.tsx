import { createFileRoute } from "@tanstack/react-router";
import { HarnessesSettings } from "../../components/settings-harnesses";

export const Route = createFileRoute("/settings/harnesses")({
  component: HarnessesSettings,
});
