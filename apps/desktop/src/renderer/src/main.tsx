import "@cogwork/ui/globals.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import App from "./app";
import { ThemeProvider } from "./components/theme-provider";
import { reportRendererError } from "./features/report-error";

// Anything that escapes React (async callbacks, event handlers, rejected promises) still reaches
// node logs, so a silent renderer failure isn't invisible on the main side.
window.addEventListener("error", (event) =>
  reportRendererError(event.error ?? event.message, "window.error"),
);
window.addEventListener("unhandledrejection", (event) =>
  reportRendererError(event.reason, "unhandledrejection"),
);

// biome-ignore lint/style/noNonNullAssertion: <If the root doesnt exist we have bigger problems>
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider>
      <App />
    </ThemeProvider>
  </StrictMode>,
);
