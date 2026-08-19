import type { BoardResult } from "./use-board";
import type { EnginePhase } from "./use-engine-status";

export type Treatment = "live" | "off" | "connecting" | "broken";

export type BoardStatus = BoardResult["_tag"];

const phaseTreatment: Record<Exclude<EnginePhase, "up">, Treatment> = {
  off: "off",
  failed: "broken",
  starting: "connecting",
};

const upBoardTreatment: Record<BoardStatus, Treatment> = {
  Success: "live",
  Initial: "connecting",
  Failure: "broken",
};

export const treatmentFor = (phase: EnginePhase, board: BoardStatus): Treatment =>
  phase === "up" ? upBoardTreatment[board] : phaseTreatment[phase];

export type BrokenReason = "engine-failed" | "daemon-unreachable";

export const brokenReason = (phase: EnginePhase): BrokenReason =>
  phase === "failed" ? "engine-failed" : "daemon-unreachable";
