import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Pull from "effect/Pull";
import * as Schedule from "effect/Schedule";
import * as SynchronizedRef from "effect/SynchronizedRef";

interface Cooldown {
  readonly untilMillis: number;
  readonly step: (nowMillis: number) => Effect.Effect<Duration.Duration>;
}

interface CooldownEntry {
  readonly entered: boolean;
  readonly retryAtMillis: number;
}

export const backoff = Schedule.exponential(Duration.minutes(1), 2).pipe(
  Schedule.modifyDelay(({ duration }) => Effect.succeed(Duration.min(duration, Duration.minutes(15)))),
);

const nextCooldown = Effect.fn("Cooldown.next")(function* (
  current: Cooldown | undefined,
  nowMillis: number,
  holdMillis: number | undefined,
) {
  const step =
    current?.step ??
    (yield* Schedule.toStep(backoff).pipe(
      Effect.map(
        (next) => (now: number) =>
          next(now, undefined).pipe(
            Pull.catchDone((duration) =>
              Effect.succeed<readonly [Duration.Duration, Duration.Duration]>([duration, duration]),
            ),
            Effect.map(([, duration]) => duration),
          ),
      ),
    ));
  const fallback = yield* step(nowMillis);
  const duration = holdMillis === undefined ? fallback : Duration.millis(holdMillis);
  return { untilMillis: nowMillis + Duration.toMillis(duration), step } satisfies Cooldown;
});

const activeAt = (cooldown: Cooldown | undefined, nowMillis: number) =>
  cooldown !== undefined && cooldown.untilMillis > nowMillis ? cooldown : null;

const withoutScope = (cooldowns: Map<string, Cooldown>, scope: string) => {
  if (!cooldowns.has(scope)) return cooldowns;
  const next = new Map(cooldowns);
  next.delete(scope);
  return next;
};

export const make = Effect.gen(function* () {
  const cooldowns = yield* SynchronizedRef.make(new Map<string, Cooldown>());

  const heldUntil = Effect.fn("Cooldown.heldUntil")(function* (scope: string) {
    const nowMillis = yield* Clock.currentTimeMillis;
    return activeAt((yield* SynchronizedRef.get(cooldowns)).get(scope), nowMillis)?.untilMillis ?? null;
  });

  const enter = Effect.fn("Cooldown.enter")(function* (scope: string, holdMillis?: number) {
    const nowMillis = yield* Clock.currentTimeMillis;
    return yield* SynchronizedRef.modifyEffect(cooldowns, (current) => {
      const active = activeAt(current.get(scope), nowMillis);
      if (active) {
        const entry: CooldownEntry = { entered: false, retryAtMillis: active.untilMillis };
        return Effect.succeed<readonly [CooldownEntry, Map<string, Cooldown>]>([entry, current]);
      }
      return Effect.map(nextCooldown(current.get(scope), nowMillis, holdMillis), (cooldown) => {
        const entry: CooldownEntry = { entered: true, retryAtMillis: cooldown.untilMillis };
        return [entry, new Map(current).set(scope, cooldown)] satisfies readonly [
          CooldownEntry,
          Map<string, Cooldown>,
        ];
      });
    });
  });

  const clear = (scope: string) =>
    SynchronizedRef.update(cooldowns, (current) => withoutScope(current, scope));

  return { heldUntil, enter, clear } as const;
});
