import { BoardResult } from "./activity-session";
import type { EnginePhase } from "./use-engine-status";

export type Treatment = "live" | "off" | "connecting" | "broken";

const phaseTreatment: Record<Exclude<EnginePhase, "up">, Treatment> = {
  off: "off",
  failed: "broken",
  starting: "connecting",
};

const upBoardTreatment = BoardResult.$match({
  Success: (): Treatment => "live",
  Initial: (): Treatment => "connecting",
  Failure: (): Treatment => "broken",
});

export const treatmentFor = (phase: EnginePhase, board: BoardResult): Treatment =>
  phase === "up" ? upBoardTreatment(board) : phaseTreatment[phase];

export type BrokenReason = "engine-failed" | "daemon-unreachable";

export const brokenReason = (phase: EnginePhase): BrokenReason =>
  phase === "failed" ? "engine-failed" : "daemon-unreachable";
