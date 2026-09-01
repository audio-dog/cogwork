const labels = {
  pending: "Pending",
  ready: "Ready",
} as const;

export const label = (state: keyof typeof labels) => labels[state];
