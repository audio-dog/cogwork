import "@clanker-forge/ui/globals.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./app";
import { ThemeProvider } from "./components/theme-provider";

// biome-ignore lint/style/noNonNullAssertion: <If the root doesnt exist we have bigger problems>
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider>
      <App />
    </ThemeProvider>
  </StrictMode>,
);
