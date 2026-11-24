import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Connections, type ConnectionsValue } from "./connections-surface";

const scriptedClient: ConnectionsValue = {
  state: {
    overview: {
      connections: [
        {
          system: "granola",
          connection: null,
          readiness: { _tag: "NotReady", reason: "Not connected" },
        },
        {
          system: "slack",
          connection: null,
          readiness: { _tag: "NotReady", reason: "Not connected" },
        },
      ],
    },
    plugins: { plugins: [] },
    pluginsLoad: "ready",
  },
  actions: {
    establish: () => Promise.resolve(null),
    reconnect: () => Promise.resolve(null),
    loginGranola: () => Promise.resolve(null),
    loginSlack: () => Promise.resolve(null),
    remove: () => undefined,
  },
  meta: { failure: null, danglingWorkspaces: [] },
};

describe("Connections surface", () => {
  it("renders browser login actions from the provider seam", () => {
    const markup = renderToStaticMarkup(
      <Connections.Provider value={scriptedClient}>
        <Connections.Content />
      </Connections.Provider>,
    );

    expect(markup).toContain("Granola");
    expect(markup).toContain("Log in");
    expect(markup).toContain("Add key");
    expect(markup).toContain("Slack");
    expect(markup).toContain("Connect Slack");
  });
});
