import * as Cause from "effect/Cause";
import { RpcClientError } from "effect/unstable/rpc/RpcClientError";

const fallback = "The daemon is unreachable. Check that the engine is running and try again.";

const readable = (value: unknown) => {
  if (value instanceof RpcClientError) return value.reason.message;
  if (value instanceof Error) return value.message;
  return undefined;
};

export const daemonErrorMessage = (cause: Cause.Cause<unknown>) => readable(Cause.squash(cause)) ?? fallback;
