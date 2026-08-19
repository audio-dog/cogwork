import { useAtomRefresh, useAtomSet, useAtomSubscribe } from "@effect/atom-react";
import type * as Atom from "effect/unstable/reactivity/Atom";
import { daemonEventsAtom, setSchedulingAtom } from "../daemon/atoms";
import { abortSchedulingToggle, syncSchedulingFromEvents } from "./sync-scheduling-to-main";

type EventsResult = typeof daemonEventsAtom extends Atom.Atom<infer V> ? V : never;

/** Root-level mirror of daemon scheduling to main — survives route changes (e.g. settings). */
export function useSchedulingMainSync() {
  const pull = useAtomSet(daemonEventsAtom);
  const resubscribe = useAtomRefresh(daemonEventsAtom);

  useAtomSubscribe(setSchedulingAtom, (current) => {
    if (current._tag === "Failure") abortSchedulingToggle();
  });

  const pump = (current: EventsResult) => {
    if (current.waiting) return;
    if (current._tag === "Failure") return resubscribe();
    if (current._tag === "Success") {
      syncSchedulingFromEvents(current.value.items);
      if (!current.value.done) pull();
    }
  };

  useAtomSubscribe(daemonEventsAtom, pump, { immediate: true });
}
