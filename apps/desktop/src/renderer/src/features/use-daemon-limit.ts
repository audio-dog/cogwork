import type { ControlStore, DaemonLimitUpdate } from "@cogwork/contracts";
import { useAtom } from "@effect/atom-react";
import { useRef } from "react";

import { setDaemonLimitAtom } from "../daemon/atoms";
import { currentControlStore } from "./daemon-limit-state";

export function useDaemonLimit(board: ControlStore | null) {
  const [result, run] = useAtom(setDaemonLimitAtom);
  const submittedRevision = useRef<number | null>(null);
  const written = result._tag === "Success" ? result.value : null;
  const controlStore = currentControlStore(board, written, submittedRevision.current);
  const setLimit = (update: DaemonLimitUpdate) => {
    submittedRevision.current = update.expectedRevision;
    run({ payload: { update } });
  };
  return { controlStore, result, setLimit };
}
