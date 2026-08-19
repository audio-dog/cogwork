import { useAtomRefresh, useAtomSubscribe, useAtomValue } from "@effect/atom-react";
import { daemonEventsAtom } from "../daemon/atoms";

export function useLiveEvents() {
  const result = useAtomValue(daemonEventsAtom);
  const resubscribe = useAtomRefresh(daemonEventsAtom);

  useAtomSubscribe(
    daemonEventsAtom,
    (current) => {
      if (current.waiting) return;
      // A dropped socket lands the stream in a terminal Failure that never
      // re-pulls on its own. Re-subscribe so a fresh WatchEvents request parks
      // on the connection gate and resumes once the daemon is reachable again.
      if (current._tag === "Failure") resubscribe();
    },
    { immediate: true },
  );

  return result;
}
