import type { SchedulerConfigUpdate } from "@cogwork/contracts";
import { useAtom } from "@effect/atom-react";
import { setSchedulerConfigAtom } from "../daemon/atoms";

// Each edit sends only the field it changed; the daemon merges it and broadcasts the new stats, so
// the value shown always tracks the real running scheduler rather than a local guess.
export function useSchedulerConfig() {
  const [result, run] = useAtom(setSchedulerConfigAtom);
  const setConfig = (update: SchedulerConfigUpdate) => run({ payload: { update } });
  return { result, setConfig };
}
