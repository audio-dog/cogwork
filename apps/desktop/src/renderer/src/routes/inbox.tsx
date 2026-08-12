import { createFileRoute } from "@tanstack/react-router";
import { EngineGate } from "../components/engine-gate";
import { Inbox } from "../components/inbox";

export const Route = createFileRoute("/inbox")({
  component: () => (
    <EngineGate title="Inbox">
      <Inbox />
    </EngineGate>
  ),
});
