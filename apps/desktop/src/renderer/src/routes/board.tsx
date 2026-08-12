import { createFileRoute } from "@tanstack/react-router";
import { Board } from "../components/board";
import { EngineGate } from "../components/engine-gate";

export const Route = createFileRoute("/board")({
  component: () => (
    <EngineGate title="Board">
      <Board />
    </EngineGate>
  ),
});
