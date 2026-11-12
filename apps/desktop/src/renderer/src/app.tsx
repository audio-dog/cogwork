import { RegistryContext } from "@effect/atom-react";
import { RouterProvider } from "@tanstack/react-router";
import { daemonAtomRegistry } from "./daemon/atom-registry";
import { router } from "./router";

function App() {
  return (
    <RegistryContext value={daemonAtomRegistry}>
      <RouterProvider router={router} />
    </RegistryContext>
  );
}

export default App;
