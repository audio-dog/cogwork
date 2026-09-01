export const label = (state: "ready" | "pending") => {
  switch (state) {
    case "ready":
      return "Ready";
    default:
      return "Pending";
  }
};
