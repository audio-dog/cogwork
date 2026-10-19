import { createFileRoute } from "@tanstack/react-router";
import { WorkflowsList } from "../../../components/workflows-list";

export const Route = createFileRoute("/_app/workflows/")({
  component: WorkflowsList,
});
