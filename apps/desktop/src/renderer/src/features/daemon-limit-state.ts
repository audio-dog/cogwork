import type { ControlStore } from "@cogwork/contracts";

const revisionOf = (controlStore: ControlStore) => controlStore.daemonLimits.revision;

export const currentControlStore = (
  board: ControlStore | null,
  written: ControlStore | null,
  submittedRevision: number | null,
) => {
  if (written === null || submittedRevision === null) return board;
  if (revisionOf(written) < submittedRevision) return board;
  if (board === null || revisionOf(written) > revisionOf(board)) return written;
  return board;
};
