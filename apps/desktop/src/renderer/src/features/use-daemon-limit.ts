import type { DaemonLimitUpdate } from "@cogwork/contracts";
import { useAtom } from "@effect/atom-react";
import { setDaemonLimitAtom } from "../daemon/atoms";

export function useDaemonLimit() {
  const [result, run] = useAtom(setDaemonLimitAtom);
  const setLimit = (update: DaemonLimitUpdate) => run({ payload: { update } });
  return { result, setLimit };
}
