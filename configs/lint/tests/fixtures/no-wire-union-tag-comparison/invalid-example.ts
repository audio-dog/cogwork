import type { DaemonEvent } from "@cogwork/contracts";

export const isSeedEnd = (event: DaemonEvent) => event._tag === "SeedEnd";
