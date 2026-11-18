import * as Context from "effect/Context";
import * as RpcMiddleware from "effect/rpc/RpcMiddleware";
import * as Schema from "effect/Schema";
import { makeBrand } from "./base-schemas";

export const PrincipalId = makeBrand("PrincipalId");
export type PrincipalId = typeof PrincipalId.Type;

export const localOwnerId: PrincipalId = Schema.decodeSync(PrincipalId)("local-owner");

export interface PrincipalIdentity {
  readonly id: PrincipalId;
}

export class Principal extends Context.Service<Principal, PrincipalIdentity>()(
  "@cogwork/contracts/principal",
) {}

export const localOwner: PrincipalIdentity = { id: localOwnerId };

export const authTokenHeader = "x-cogwork-token";

export class PrincipalMiddleware extends RpcMiddleware.Service<
  PrincipalMiddleware,
  {
    provides: Principal;
  }
>()("@cogwork/contracts/PrincipalMiddleware") {}
