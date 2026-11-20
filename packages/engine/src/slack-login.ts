import { ConnectionFailure } from "@cogwork/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

import type { StoredCredential } from "./credential-store";

export interface SlackLoginService {
  readonly login: Effect.Effect<StoredCredential, ConnectionFailure>;
}

const unavailable: SlackLoginService = {
  login: Effect.fail(
    new ConnectionFailure({
      operation: "login Slack",
      connectionId: null,
      message: "Slack browser login is unavailable in this host",
    }),
  ),
};

export const SlackLogin = Context.Reference<SlackLoginService>("@cogwork/engine/slack-login/SlackLogin", {
  defaultValue: () => unavailable,
});
