type DaemonEvent = { readonly _tag: "SeedEnd" } | { readonly _tag: "RunActivity" };

export const isSeedEnd = (event: DaemonEvent) => event._tag === "SeedEnd";
