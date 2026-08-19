import type { DaemonEvent, SchedulingState } from "@cogwork/contracts";

type PendingToggle = {
  readonly desired: SchedulingState;
  readonly stale: SchedulingState;
};

let pendingToggle: PendingToggle | null = null;

const sendSchedulingToMain = (desired: SchedulingState) => {
  window.cogwork.setSchedulingState(desired);
};

/** Optimistic mirror for supervisor restarts — ignore pre-toggle stream events until the daemon confirms. */
export const syncSchedulingFromToggle = (desired: SchedulingState, stale: SchedulingState) => {
  pendingToggle = { desired, stale };
  sendSchedulingToMain(desired);
};

export const abortSchedulingToggle = () => {
  const revert = pendingToggle?.stale;
  pendingToggle = null;
  if (revert !== undefined) sendSchedulingToMain(revert);
};

export const syncSchedulingFromEvents = (events: ReadonlyArray<DaemonEvent>) => {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?._tag === "SchedulerChanged") {
      const scheduling = event.scheduler.scheduling;
      if (pendingToggle !== null) {
        if (scheduling === pendingToggle.stale) return;
        if (scheduling === pendingToggle.desired) pendingToggle = null;
        else pendingToggle = null;
      }
      sendSchedulingToMain(scheduling);
      return;
    }
  }
};
