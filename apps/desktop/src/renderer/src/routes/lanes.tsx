import { createFileRoute } from "@tanstack/react-router";
import { EngineGate } from "../components/engine-gate";
import { Lanes } from "../components/lanes";

export const Route = createFileRoute("/lanes")({
  component: () => (
    <EngineGate title="Lanes">
      <Lanes />
    </EngineGate>
  ),
});
