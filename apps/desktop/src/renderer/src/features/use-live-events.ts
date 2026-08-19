import { useAtomRefresh, useAtomSet, useAtomSubscribe, useAtomValue } from "@effect/atom-react";
import type * as Atom from "effect/unstable/reactivity/Atom";
import { daemonEventsAtom } from "../daemon/atoms";
import { syncSchedulingFromEvents } from "./sync-scheduling-to-main";

type EventsResult = typeof daemonEventsAtom extends Atom.Atom<infer V> ? V : never;

export function useLiveEvents() {
  const result = useAtomValue(daemonEventsAtom);
  const pull = useAtomSet(daemonEventsAtom);
  const resubscribe = useAtomRefresh(daemonEventsAtom);

  const pump = (current: EventsResult) => {
    if (current.waiting) return;
    // A dropped socket lands the stream in a terminal Failure that never
    // re-pulls on its own. Re-subscribe so a fresh WatchEvents request parks
    // on the connection gate and resumes once the daemon is reachable again.
    if (current._tag === "Failure") return resubscribe();
    if (current._tag === "Success") {
      syncSchedulingFromEvents(current.value.items);
      if (!current.value.done) pull();
    }
  };

  useAtomSubscribe(daemonEventsAtom, pump, { immediate: true });

  return result;
}
