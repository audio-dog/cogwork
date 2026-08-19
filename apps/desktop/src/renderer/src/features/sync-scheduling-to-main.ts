import type { DaemonEvent, SchedulingState } from "@cogwork/contracts";

export const syncSchedulingToMain = (desired: SchedulingState) => {
  window.cogwork.setSchedulingState(desired);
};

export const syncSchedulingFromEvents = (events: ReadonlyArray<DaemonEvent>) => {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?._tag === "SchedulerChanged") {
      syncSchedulingToMain(event.scheduler.scheduling);
      return;
    }
  }
};
