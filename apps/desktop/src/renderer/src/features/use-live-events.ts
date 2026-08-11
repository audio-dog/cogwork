import { useAtomSet, useAtomSubscribe, useAtomValue } from "@effect/atom-react";
import type * as Atom from "effect/unstable/reactivity/Atom";
import { useCallback } from "react";
import { daemonEventsAtom } from "../daemon/atoms";

type EventsResult = typeof daemonEventsAtom extends Atom.Atom<infer V> ? V : never;

export function useLiveEvents() {
  const result = useAtomValue(daemonEventsAtom);
  const pull = useAtomSet(daemonEventsAtom);

  const pump = useCallback(
    (current: EventsResult) => {
      if (current._tag === "Success" && !current.waiting && !current.value.done) pull();
    },
    [pull],
  );

  useAtomSubscribe(daemonEventsAtom, pump, { immediate: true });

  return result;
}
