import {
  type WorkflowCatalogEntry,
  WorkflowCatalogKey,
  type WorkflowOption,
  type WorkflowParameterValue,
} from "@cogwork/contracts";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  SourceFailure,
  type TriggerEvent,
  type TriggerSource,
  type TriggerSubscription,
} from "./trigger-source";

const hourlyKey = Schema.decodeSync(WorkflowCatalogKey)("schedule.hourly");
const dailyKey = Schema.decodeSync(WorkflowCatalogKey)("schedule.daily");
const weeklyKey = Schema.decodeSync(WorkflowCatalogKey)("schedule.weekly");

const numberValues = (end: number) => Array.from({ length: end }, (_, value) => String(value));
const minutes = numberValues(60);
const hours = numberValues(24);
const weekdays = numberValues(7);

const parameter = (id: string, source: "fixed" | "live", values: ReadonlyArray<string>) => ({
  id,
  required: true,
  source,
  values,
});

const scheduleEntry = (
  key: typeof hourlyKey,
  name: string,
  parameters: WorkflowCatalogEntry["parameters"],
): WorkflowCatalogEntry => ({
  key,
  name,
  kind: "trigger",
  system: null,
  connection: null,
  requires: [],
  parameters,
  itemKind: "schedule",
  actsOn: [],
  requiresWorkspace: false,
  permissionProfile: "read-only",
  agentInputs: [],
  emits: [],
});

export const clockEntries: ReadonlyArray<WorkflowCatalogEntry> = [
  scheduleEntry(hourlyKey, "Every hour", [
    parameter("minute", "fixed", minutes),
    parameter("zone", "live", []),
  ]),
  scheduleEntry(dailyKey, "Every day", [
    parameter("hour", "fixed", hours),
    parameter("minute", "fixed", minutes),
    parameter("zone", "live", []),
  ]),
  scheduleEntry(weeklyKey, "Every week", [
    parameter("weekday", "fixed", weekdays),
    parameter("hour", "fixed", hours),
    parameter("minute", "fixed", minutes),
    parameter("zone", "live", []),
  ]),
];

type ClockSchedule = Data.TaggedEnum<{
  Hourly: { readonly minute: number; readonly zone: string };
  Daily: { readonly hour: number; readonly minute: number; readonly zone: string };
  Weekly: {
    readonly weekdays: ReadonlySet<number>;
    readonly hour: number;
    readonly minute: number;
    readonly zone: string;
  };
}>;

const ClockSchedule = Data.taggedEnum<ClockSchedule>();

const valuesOf = (parameters: ReadonlyArray<WorkflowParameterValue>, id: string) =>
  parameters.filter((parameter) => parameter.id === id).map(({ value }) => value);

const firstValue = (parameters: ReadonlyArray<WorkflowParameterValue>, id: string) =>
  valuesOf(parameters, id)[0];

const integerOf = (parameters: ReadonlyArray<WorkflowParameterValue>, id: string, upper: number) => {
  const value = Number(firstValue(parameters, id));
  return Number.isInteger(value) && value >= 0 && value < upper ? value : null;
};

const zoneOf = (parameters: ReadonlyArray<WorkflowParameterValue>) => {
  const zone = firstValue(parameters, "zone");
  return zone && Option.isSome(DateTime.zoneMakeNamed(zone)) ? zone : null;
};

type ScheduleParser = (parameters: ReadonlyArray<WorkflowParameterValue>) => ClockSchedule | null;

const scheduleParsers: Readonly<Record<string, ScheduleParser>> = {
  [hourlyKey]: (parameters) => {
    const minute = integerOf(parameters, "minute", 60);
    const zone = zoneOf(parameters);
    return minute === null || zone === null ? null : ClockSchedule.Hourly({ minute, zone });
  },
  [dailyKey]: (parameters) => {
    const hour = integerOf(parameters, "hour", 24);
    const minute = integerOf(parameters, "minute", 60);
    const zone = zoneOf(parameters);
    return hour === null || minute === null || zone === null
      ? null
      : ClockSchedule.Daily({ hour, minute, zone });
  },
  [weeklyKey]: (parameters) => {
    const hour = integerOf(parameters, "hour", 24);
    const minute = integerOf(parameters, "minute", 60);
    const zone = zoneOf(parameters);
    const days = valuesOf(parameters, "weekday")
      .map(Number)
      .filter((day) => weekdays.includes(String(day)));
    return hour === null || minute === null || zone === null || days.length === 0
      ? null
      : ClockSchedule.Weekly({ hour, minute, zone, weekdays: new Set(days) });
  },
};

const scheduleOf = (subscription: TriggerSubscription) =>
  scheduleParsers[subscription.entry]?.(subscription.parameters) ?? null;

const localPartsAt = (millis: number, zone: string) =>
  DateTime.toParts(DateTime.makeZonedUnsafe(millis, { timeZone: zone }));

const sameLocalMinute = (
  left: DateTime.DateTime.PartsWithWeekday,
  right: DateTime.DateTime.PartsWithWeekday,
) =>
  left.year === right.year &&
  left.month === right.month &&
  left.day === right.day &&
  left.hour === right.hour &&
  left.minute === right.minute;

const validLocalInstant = (parts: DateTime.DateTime.Parts, zone: string) => {
  const local = DateTime.makeZonedUnsafe(parts, {
    timeZone: zone,
    adjustForTimeZone: true,
    disambiguation: "earlier",
  });
  return sameLocalMinute(DateTime.toParts(local), { ...parts, weekDay: 0 })
    ? DateTime.toEpochMillis(local)
    : null;
};

const nextValidLocalMinute = (parts: DateTime.DateTime.Parts, zone: string) => {
  const naive = DateTime.makeUnsafe(parts);
  const candidateAt = (offset: number) => DateTime.toPartsUtc(DateTime.add(naive, { minutes: offset }));
  const validOffset = Array.from({ length: 181 }, (_, offset) => offset).find(
    (offset) => validLocalInstant(candidateAt(offset), zone) !== null,
  );
  return validOffset === undefined ? null : validLocalInstant(candidateAt(validOffset), zone);
};

const hoursFor = (schedule: ClockSchedule) =>
  ClockSchedule.$match(schedule, {
    Hourly: () => Array.from({ length: 24 }, (_, hour) => hour),
    Daily: ({ hour }) => [hour],
    Weekly: ({ hour }) => [hour],
  });

const includesDay = (schedule: ClockSchedule, weekDay: number) =>
  ClockSchedule.$match(schedule, {
    Hourly: () => true,
    Daily: () => true,
    Weekly: ({ weekdays }) => weekdays.has(weekDay),
  });

const candidatesNear = (schedule: ClockSchedule, aroundMillis: number) => {
  const around = localPartsAt(aroundMillis, schedule.zone);
  const day = DateTime.makeUnsafe({ year: around.year, month: around.month, day: around.day });
  return Array.from({ length: 17 }, (_, index) => index - 8)
    .map((offset) => DateTime.toPartsUtc(DateTime.add(day, { days: offset })))
    .filter(({ weekDay }) => includesDay(schedule, weekDay))
    .flatMap((parts) =>
      hoursFor(schedule).map((hour) =>
        nextValidLocalMinute(
          {
            year: parts.year,
            month: parts.month,
            day: parts.day,
            hour,
            minute: schedule.minute,
            second: 0,
            millisecond: 0,
          },
          schedule.zone,
        ),
      ),
    )
    .filter((instant) => instant !== null)
    .sort((left, right) => left - right);
};

export const nextScheduledInstant = (subscription: TriggerSubscription, afterMillis: number) => {
  const schedule = scheduleOf(subscription);
  return schedule
    ? (candidatesNear(schedule, afterMillis).find((instant) => instant > afterMillis) ?? null)
    : null;
};

export const latestScheduledInstant = (subscription: TriggerSubscription, atMillis: number) => {
  const schedule = scheduleOf(subscription);
  return schedule
    ? (candidatesNear(schedule, atMillis).findLast((instant) => instant <= atMillis) ?? null)
    : null;
};

export const matchesScheduledInstant = (subscription: TriggerSubscription, instantMillis: number) =>
  latestScheduledInstant(subscription, instantMillis) === instantMillis;

const eventOf = (
  subscription: TriggerSubscription,
  instant: number,
  firedAtMillis: number,
): TriggerEvent => ({
  key: { _tag: "ScheduleInstant", workflow: subscription.workflow, instantMillis: instant },
  revision: String(instant),
  cause: { _tag: "Unknown" },
  atMillis: firedAtMillis,
  entry: subscription.entry,
  workspace: null,
});

const invalidSchedule = (subscription: TriggerSubscription) =>
  new SourceFailure({
    source: "clock",
    reason: "decode",
    retryAfterMillis: null,
    message: `Invalid ${subscription.entry} schedule`,
  });

const futureEvents = (subscription: TriggerSubscription, afterMillis: number) =>
  Stream.unfold(afterMillis, (previous) =>
    Effect.gen(function* () {
      const next = nextScheduledInstant(subscription, previous);
      if (next === null) return yield* invalidSchedule(subscription);
      const now = yield* Clock.currentTimeMillis;
      yield* Effect.sleep(Math.max(0, next - now));
      const firedAtMillis = yield* Clock.currentTimeMillis;
      const latest = latestScheduledInstant(subscription, firedAtMillis);
      if (latest === null) return yield* invalidSchedule(subscription);
      return [eventOf(subscription, latest, firedAtMillis), latest] as const;
    }),
  );

const observeSubscription = (subscription: TriggerSubscription) =>
  Stream.unwrap(
    Effect.map(Clock.currentTimeMillis, (now) => {
      const latest = latestScheduledInstant(subscription, now);
      const catchUp =
        latest !== null && latest > (subscription.catchUp?.since ?? now)
          ? [eventOf(subscription, latest, now)]
          : [];
      return Stream.concat(Stream.fromIterable(catchUp), futureEvents(subscription, latest ?? now));
    }),
  );

export const clockSource: TriggerSource = {
  id: "clock",
  entries: clockEntries,
  availability: () => Effect.succeed({ _tag: "Available" }),
  listOptions: (entry, parameter) => {
    const isZoneParameter = parameter === "zone" && clockEntries.some(({ key }) => key === entry);
    if (!isZoneParameter) return Effect.succeed([]);
    const zones = [...new Set(["UTC", ...Intl.supportedValuesOf("timeZone")])];
    return Effect.succeed(
      zones.map((zone) => ({ value: zone, name: zone, listedIn: [] }) satisfies WorkflowOption),
    );
  },
  observe: (subscriptions) =>
    subscriptions.length === 0
      ? Stream.empty
      : Stream.mergeAll(subscriptions.map(observeSubscription), { concurrency: "unbounded" }),
};
