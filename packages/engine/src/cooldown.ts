import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

interface Cooldown {
  readonly untilMillis: number;
  readonly consecutive: number;
}

interface CooldownEntry {
  readonly entered: boolean;
  readonly retryAtMillis: number;
}

const baseBackoffMillis = 60_000;
const maxBackoffMillis = 900_000;

const backoffMillis = (consecutive: number) =>
  Math.min(baseBackoffMillis * 2 ** (consecutive - 1), maxBackoffMillis);

const activeAt = (cooldown: Cooldown | undefined, nowMillis: number) =>
  cooldown !== undefined && cooldown.untilMillis > nowMillis ? cooldown : null;

const withoutScope = (cooldowns: Map<string, Cooldown>, scope: string) => {
  if (!cooldowns.has(scope)) return cooldowns;
  const next = new Map(cooldowns);
  next.delete(scope);
  return next;
};

export const make = Effect.gen(function* () {
  const cooldowns = yield* Ref.make(new Map<string, Cooldown>());

  const heldUntil = Effect.fn("Cooldown.heldUntil")(function* (scope: string) {
    const nowMillis = yield* Clock.currentTimeMillis;
    return activeAt((yield* Ref.get(cooldowns)).get(scope), nowMillis)?.untilMillis ?? null;
  });

  const enter = Effect.fn("Cooldown.enter")(function* (scope: string, holdMillis?: number) {
    const nowMillis = yield* Clock.currentTimeMillis;
    return yield* Ref.modify(cooldowns, (current): readonly [CooldownEntry, Map<string, Cooldown>] => {
      const active = activeAt(current.get(scope), nowMillis);
      if (active) return [{ entered: false, retryAtMillis: active.untilMillis }, current];
      const consecutive = (current.get(scope)?.consecutive ?? 0) + 1;
      const cooldown: Cooldown = {
        untilMillis: nowMillis + (holdMillis ?? backoffMillis(consecutive)),
        consecutive,
      };
      return [{ entered: true, retryAtMillis: cooldown.untilMillis }, new Map(current).set(scope, cooldown)];
    });
  });

  const clear = (scope: string) => Ref.update(cooldowns, (current) => withoutScope(current, scope));

  return { heldUntil, enter, clear } as const;
});
