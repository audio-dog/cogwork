import type { SchedulingState } from "@cogwork/contracts";
import { useAtom } from "@effect/atom-react";
import { setSchedulingAtom } from "../daemon/atoms";
import { syncSchedulingFromToggle } from "./sync-scheduling-to-main";

export function useScheduling() {
  const [result, run] = useAtom(setSchedulingAtom);
  const setScheduling = (desired: SchedulingState) => {
    syncSchedulingFromToggle(desired);
    run({ payload: { desired } });
  };
  return { result, setScheduling };
}
