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

export interface UtilityCall {
  readonly model?: string;
  readonly system?: string;
  readonly prompt: string;
}

export class UtilityCallError extends Schema.TaggedError<UtilityCallError>()("UtilityCallError", {
  model: Schema.String,
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
        Effect.mapError((error) => new UtilityCallError({ model: reference, message: error.message })),
      );
      return yield* Effect.callback<string, UtilityCallError>((resume) => {
        const abortController = new AbortController();
        runChat({ adapter, system: call.system, prompt: call.prompt, abortController })
          .then((text) => resume(Effect.succeed(text)))
          .catch((error) =>
            resume(Effect.fail(new UtilityCallError({ model: reference, message: errorMessage(error) }))),
          );
        return Effect.sync(() => abortController.abort());
      });
    }),
  };
};

export const layer = Layer.effect(
  UtilityModel,
  Effect.map(CredentialStore, (credentialStore) => make(credentialStore)),
);
