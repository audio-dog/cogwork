import { RegistryContext } from "@effect/atom-react";
import { RouterProvider } from "@tanstack/react-router";
import { registry } from "./daemon/registry";
import { router } from "./router";

function App() {
  return (
    <RegistryContext value={registry}>
      <RouterProvider router={router} />
    </RegistryContext>
  );
}

export default App;
