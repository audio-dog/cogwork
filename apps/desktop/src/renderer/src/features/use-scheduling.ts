import type { SchedulingState } from "@cogwork/contracts";
import { useAtom, useAtomSubscribe } from "@effect/atom-react";
import { setSchedulingAtom } from "../daemon/atoms";
import { abortSchedulingToggle, syncSchedulingFromToggle } from "./sync-scheduling-to-main";

export function useScheduling() {
  const [result, run] = useAtom(setSchedulingAtom);

  useAtomSubscribe(setSchedulingAtom, (current) => {
    if (current._tag === "Failure") abortSchedulingToggle();
  });

  const setScheduling = (desired: SchedulingState) => {
    const stale: SchedulingState = desired === "running" ? "paused" : "running";
    syncSchedulingFromToggle(desired, stale);
    run({ payload: { desired } });
  };
  return { result, setScheduling };
}
