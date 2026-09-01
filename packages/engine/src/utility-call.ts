import { chat } from "@tanstack/ai";
import type { AnyTextAdapter } from "@tanstack/ai/adapters";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { CredentialStore, type CredentialStoreService } from "./credential-store";
import type { ModelAdapterFactory } from "./provider-adapter";
import { resolveModelAdapter } from "./provider-resolve";

export const defaultUtilityModel = "anthropic/claude-haiku-4-5";
const utilityCallDeadline = "2 minutes";

export interface UtilityCall {
  readonly model?: string;
  readonly system?: string;
  readonly prompt: string;
}

export class UtilityCallError extends Schema.TaggedError<UtilityCallError>()("UtilityCallError", {
  model: Schema.String,
  reason: Schema.Literals(["call-failed", "timeout"]),
  message: Schema.String,
}) {}

export interface UtilityModelService {
  readonly complete: (call: UtilityCall) => Effect.Effect<string, UtilityCallError>;
}

export class UtilityModel extends Context.Service<UtilityModel, UtilityModelService>()(
  "@cogwork/engine/utility-call/UtilityModel",
) {}

export interface UtilityChatOptions {
  readonly adapter: AnyTextAdapter;
  readonly system?: string;
  readonly prompt: string;
  readonly abortController: AbortController;
}

export type UtilityChat = (options: UtilityChatOptions) => Promise<string>;

const defaultUtilityChat: UtilityChat = (options) =>
  chat({
    adapter: options.adapter,
    systemPrompts: options.system ? [options.system] : [],
    messages: [{ role: "user", content: options.prompt }],
    stream: false,
    abortController: options.abortController,
  });

export interface UtilityModelOptions {
  readonly makeAdapter?: ModelAdapterFactory;
  readonly runChat?: UtilityChat;
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

export const make = (
  credentialStore: CredentialStoreService,
  options: UtilityModelOptions = {},
): UtilityModelService => {
  const runChat = options.runChat ?? defaultUtilityChat;
  return {
    complete: Effect.fn("UtilityModel.complete")(function* (call: UtilityCall) {
      const reference = call.model ?? defaultUtilityModel;
      const adapter = yield* resolveModelAdapter(credentialStore, reference, options.makeAdapter).pipe(
        Effect.mapError(
          (error) =>
            new UtilityCallError({ model: reference, reason: "call-failed", message: error.message }),
        ),
      );
      return yield* Effect.tryPromise({
        try: (signal) => {
          const abortController = new AbortController();
          const abort = () => abortController.abort(signal.reason);
          signal.addEventListener("abort", abort, { once: true });
          return runChat({ adapter, system: call.system, prompt: call.prompt, abortController }).finally(() =>
            signal.removeEventListener("abort", abort),
          );
        },
        catch: (error) =>
          new UtilityCallError({ model: reference, reason: "call-failed", message: errorMessage(error) }),
      }).pipe(
        Effect.timeoutOrElse({
          duration: utilityCallDeadline,
          orElse: () =>
            Effect.fail(
              new UtilityCallError({
                model: reference,
                reason: "timeout",
                message: `utility call timed out after ${utilityCallDeadline}`,
              }),
            ),
        }),
      );
    }),
  };
};

export const layer = Layer.effect(
  UtilityModel,
  Effect.map(CredentialStore, (credentialStore) => make(credentialStore)),
);
