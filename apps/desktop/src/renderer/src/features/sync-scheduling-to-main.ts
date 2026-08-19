import type { DaemonEvent, SchedulingState } from "@cogwork/contracts";

let pendingToggle: SchedulingState | null = null;

const sendSchedulingToMain = (desired: SchedulingState) => {
  window.cogwork.setSchedulingState(desired);
};

/** Optimistic mirror for supervisor restarts — wins over stale stream events until the daemon confirms. */
export const syncSchedulingFromToggle = (desired: SchedulingState) => {
  pendingToggle = desired;
  sendSchedulingToMain(desired);
};

export const syncSchedulingFromEvents = (events: ReadonlyArray<DaemonEvent>) => {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?._tag === "SchedulerChanged") {
      const scheduling = event.scheduler.scheduling;
      if (pendingToggle !== null) {
        if (scheduling !== pendingToggle) return;
        pendingToggle = null;
      }
      sendSchedulingToMain(scheduling);
      return;
    }
  }
};
