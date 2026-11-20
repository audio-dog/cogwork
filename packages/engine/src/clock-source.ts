import {
  keyOf,
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
  type TriggerEntry,
  type TriggerEvent,
  type TriggerReadPort,
  type TriggerSource,
  type TriggerSubscription,
} from "./trigger-source";
import { mergeOptions, type OptionReader } from "./workflow-options";

const hourlyKey = Schema.decodeSync(WorkflowCatalogKey)("schedule.hourly");
const dailyKey = Schema.decodeSync(WorkflowCatalogKey)("schedule.daily");
const weeklyKey = Schema.decodeSync(WorkflowCatalogKey)("schedule.weekly");
export const sweepKey = Schema.decodeSync(WorkflowCatalogKey)("schedule.sweep");

const numberValues = (end: number) => Array.from({ length: end }, (_, value) => String(value));
const minutes = numberValues(60);
const hours = numberValues(24);
const weekdays = numberValues(7);
const idleDays = ["1", "7", "14", "30", "60", "90"];

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
  itemKind = "schedule",
): TriggerEntry => ({
  key,
  name,
  kind: "trigger",
  triggerKind: "occurrence",
  system: null,
  connection: null,
  requires: [],
  parameters,
  itemKind,
  actsOn: [],
  requiresWorkspace: false,
  workspaceSource: null,
  permissionProfile: "read-only",
  agentInputs: [],
  emits: [],
});

export const clockEntries: ReadonlyArray<TriggerEntry> = [
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
  scheduleEntry(
    sweepKey,
    "Sweep idle items",
    [
      parameter("hour", "fixed", hours),
      parameter("minute", "fixed", minutes),
      parameter("zone", "live", []),
      parameter("source", "fixed", ["trackers", "workflow"]),
      parameter("state", "live", []),
      parameter("idle-days", "live", []),
    ],
    "issue",
  ),
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

const dailyParser: ScheduleParser = (parameters) => {
  const hour = integerOf(parameters, "hour", 24);
  const minute = integerOf(parameters, "minute", 60);
  const zone = zoneOf(parameters);
  return hour === null || minute === null || zone === null
    ? null
    : ClockSchedule.Daily({ hour, minute, zone });
};

const scheduleParsers: Readonly<Record<string, ScheduleParser>> = {
  [hourlyKey]: (parameters) => {
    const minute = integerOf(parameters, "minute", 60);
    const zone = zoneOf(parameters);
    return minute === null || zone === null ? null : ClockSchedule.Hourly({ minute, zone });
  },
  [dailyKey]: dailyParser,
  [sweepKey]: dailyParser,
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

const sweepIdleMillis = (subscription: TriggerSubscription) => {
  const days = Number(firstValue(subscription.parameters, "idle-days"));
  return Number.isInteger(days) && days > 0 ? days * 86_400_000 : null;
};

const sweepEventsAt = Effect.fn("ClockSource.sweepEventsAt")(function* (
  subscription: TriggerSubscription,
  instant: number,
  readPort: TriggerReadPort | undefined,
) {
  const idleMillis = sweepIdleMillis(subscription);
  if (idleMillis === null) return yield* invalidSchedule(subscription);
  if (readPort === undefined) {
    return yield* new SourceFailure({
      source: "clock",
      reason: "unavailable",
      retryAfterMillis: null,
      message: "Sweep item reader is unavailable",
    });
  }
  const candidates = yield* readPort.sweep(subscription, instant);
  const selected = candidates
    .filter(({ lastTouchedAtMillis }) => lastTouchedAtMillis <= instant - idleMillis)
    .toSorted(
      (left, right) =>
        left.lastTouchedAtMillis - right.lastTouchedAtMillis ||
        keyOf(left.key).localeCompare(keyOf(right.key)),
    )
    .slice(0, 50);
  return yield* Effect.forEach(selected, (candidate) =>
    Effect.gen(function* () {
      const loadWorkContext = candidate.loadWorkContext ?? Effect.void;
      const workContext = yield* loadWorkContext;
      return {
        key: candidate.key,
        revision: `${subscription.workflow}:${instant}`,
        cause: { _tag: "Clock" },
        atMillis: instant,
        entry: subscription.entry,
        workspace: candidate.workspace,
        subject: candidate.subject,
        target: { workflow: subscription.workflow, trigger: subscription.trigger },
        ...(workContext === undefined ? {} : { workContext }),
        ...(candidate.pullRequest === undefined ? {} : { pullRequest: candidate.pullRequest }),
      } satisfies TriggerEvent;
    }),
  );
});

const invalidSchedule = (subscription: TriggerSubscription) =>
  new SourceFailure({
    source: "clock",
    reason: "decode",
    retryAfterMillis: null,
    message: `Invalid ${subscription.entry} schedule`,
  });

const eventsAt = (
  subscription: TriggerSubscription,
  instant: number,
  firedAtMillis: number,
  readPort: TriggerReadPort | undefined,
) =>
  subscription.entry === sweepKey
    ? sweepEventsAt(subscription, instant, readPort)
    : Effect.succeed([eventOf(subscription, instant, firedAtMillis)]);

const futureEvents = (
  subscription: TriggerSubscription,
  afterMillis: number,
  readPort: TriggerReadPort | undefined,
) =>
  Stream.unfold(afterMillis, (previous) =>
    Effect.gen(function* () {
      const next = nextScheduledInstant(subscription, previous);
      if (next === null) return yield* invalidSchedule(subscription);
      const now = yield* Clock.currentTimeMillis;
      yield* Effect.sleep(Math.max(0, next - now));
      const firedAtMillis = yield* Clock.currentTimeMillis;
      const latest = latestScheduledInstant(subscription, firedAtMillis);
      if (latest === null) return yield* invalidSchedule(subscription);
      return [yield* eventsAt(subscription, latest, firedAtMillis, readPort), latest] as const;
    }),
  ).pipe(Stream.flatMap(Stream.fromIterable));

const observeSubscription = (subscription: TriggerSubscription, readPort: TriggerReadPort | undefined) =>
  Stream.unwrap(
    Effect.map(Clock.currentTimeMillis, (now) => {
      const latest = latestScheduledInstant(subscription, now);
      const shouldCatchUp = latest !== null && latest > (subscription.catchUp?.since ?? now);
      const catchUp = shouldCatchUp
        ? Stream.fromEffect(eventsAt(subscription, latest, now, readPort)).pipe(
            Stream.flatMap(Stream.fromIterable),
          )
        : Stream.empty;
      return Stream.concat(catchUp, futureEvents(subscription, latest ?? now, readPort));
    }),
  );

const valueOptions = (values: ReadonlyArray<string>) =>
  Effect.succeed(values.map((value) => ({ value, name: value, listedIn: [] }) satisfies WorkflowOption));

const sweepStateReader =
  (labelReaders: ReadonlyArray<OptionReader>): OptionReader =>
  (workspace) =>
    Effect.forEach(labelReaders, (reader) =>
      reader(workspace).pipe(Effect.catchTag("SourceFailure", () => Effect.succeed([]))),
    ).pipe(
      Effect.map((listed) =>
        mergeOptions([
          [{ value: "parked", name: "parked", listedIn: workspace === undefined ? [] : [workspace] }],
          ...listed,
        ]),
      ),
    );

const clockReaders = (sources: ReadonlyArray<TriggerSource>) => {
  const labelReaders = sources.flatMap(({ options = [] }) =>
    options.flatMap(({ readers }) => (readers.label ? [readers.label] : [])),
  );
  return {
    zone: () => valueOptions([...new Set(["UTC", ...Intl.supportedValuesOf("timeZone")])]),
    "idle-days": () => valueOptions(idleDays),
    state: sweepStateReader(labelReaders),
  };
};

export const makeClockSource = (sweepStateSources: ReadonlyArray<TriggerSource> = []): TriggerSource => ({
  id: "clock",
  entries: clockEntries,
  availability: () => Effect.succeed({ _tag: "Available" }),
  options: [{ system: "schedule", readers: clockReaders(sweepStateSources) }],
  observe: (subscriptions, readPort) =>
    subscriptions.length === 0
      ? Stream.empty
      : Stream.mergeAll(
          subscriptions.map((subscription) => observeSubscription(subscription, readPort)),
          { concurrency: "unbounded" },
        ),
});

export const clockSource = makeClockSource();
