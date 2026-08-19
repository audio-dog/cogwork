import type { BoardResult } from "./use-board";
import type { EnginePhase } from "./use-engine-status";

export type Treatment = "live" | "off" | "connecting" | "broken";

export type BoardStatus = BoardResult["_tag"];

export const treatmentFor = (phase: EnginePhase, board: BoardStatus): Treatment => {
  switch (phase) {
    case "off":
      return "off";
    case "failed":
      return "broken";
    case "starting":
      return "connecting";
    case "up":
      switch (board) {
        case "Success":
          return "live";
        case "Initial":
          return "connecting";
        case "Failure":
          return "broken";
      }
  }
};

export type BrokenReason = "engine-failed" | "daemon-unreachable";

export const brokenReason = (phase: EnginePhase): BrokenReason =>
  phase === "failed" ? "engine-failed" : "daemon-unreachable";
