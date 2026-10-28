import { ConnectionFailure } from "@cogwork/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type { StoredCredential } from "./credential-store";

export interface GranolaLoginService {
  readonly login: (account: string) => Effect.Effect<StoredCredential, ConnectionFailure>;
}

const unavailable: GranolaLoginService = {
  login: () =>
    Effect.fail(
      new ConnectionFailure({
        operation: "login Granola",
        connectionId: null,
        message: "Granola browser login is unavailable in this host",
      }),
    ),
};

export const GranolaLogin = Context.Reference<GranolaLoginService>(
  "@cogwork/engine/granola-login/GranolaLogin",
  { defaultValue: () => unavailable },
);
