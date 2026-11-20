import type { SchedulingState } from "@cogwork/contracts";
import { useAtom } from "@effect/atom-react";

import { setSchedulingAtom } from "../daemon/atoms";

export function useScheduling() {
  const [result, run] = useAtom(setSchedulingAtom);
  const setScheduling = (desired: SchedulingState) => run({ payload: { desired } });
  return { result, setScheduling };
}
