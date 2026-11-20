import {
  SlackWriteKey,
  WorkflowActionOrigin,
  type WorkflowActionPlanStep,
  WorkflowActionTarget,
  type WorkflowCatalogEntry,
  WorkflowSlackActionArtifact,
  WorkItemRef,
} from "@cogwork/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { type SlackPostReceipt, SlackWriteError, slackActionRows } from "./slack-write";
import {
  type ActionContext,
  type ActionEntry,
  type ActionExecutor,
  decodeFailure,
  parameterValues,
  stringInput,
  type TargetProducer,
  WorkflowActionPlanDecodeError,
} from "./workflow-action-entry";

const decodeSlackTarget = Schema.decodeUnknownEffect(WorkflowActionTarget);

const slackTarget = (target: unknown) =>
  decodeSlackTarget(target).pipe(
    Effect.mapError(() =>
      WorkflowActionPlanDecodeError.make({ reason: "invalid", message: "The Slack target is invalid" }),
    ),
  );

const slackItemTarget: TargetProducer = ({ admission }) =>
  WorkItemRef.matchOrElse(
    admission.event.key,
    {
      SlackMessage: ({ team, channel, ts, threadTs }) =>
        slackTarget({
          _tag: "SlackMessage",
          team,
          channel,
          ts,
          threadTs: threadTs ?? ts,
        }),
      SlackConversation: ({ team, channel, threadTs }) =>
        slackTarget({
          _tag: "SlackMessage",
          team,
          channel,
          ts: threadTs,
          threadTs,
        }),
    },
    () => decodeFailure("The Slack action needs a Slack item"),
  );

const slackChannelTarget: TargetProducer = ({ parameters }) => {
  const channel = parameters.find(({ id }) => id === "channel")?.value.trim();
  return channel
    ? slackTarget({ _tag: "SlackChannel", channel })
    : decodeFailure("The Slack message action needs a channel");
};

const slackInvalidTarget = (step: WorkflowActionPlanStep) =>
  new SlackWriteError({
    reason: "invalid",
    retryable: false,
    message: `Action ${step.entry} has an invalid target`,
  });

const requireSlackMessage = (step: WorkflowActionPlanStep) =>
  WorkflowActionTarget.guards.SlackMessage(step.target)
    ? Effect.succeed(step.target)
    : Effect.fail(slackInvalidTarget(step));

const requireSlackWriteKey = (step: WorkflowActionPlanStep) =>
  Schema.decodeEffect(SlackWriteKey)(step.writeKey).pipe(Effect.mapError(() => slackInvalidTarget(step)));

const slackArtifact = (context: ActionContext, receipt: SlackPostReceipt) =>
  WorkflowSlackActionArtifact.make({
    ...receipt,
    origin: WorkflowActionOrigin.make({
      item: context.plan.item,
      workflow: context.plan.workflow,
      attempt: context.plan.attempt,
      writeKey: context.step.writeKey,
      lineage: context.plan.lineage,
    }),
  });

const sendMessage = Effect.fn("WorkflowActionPlan.sendSlackMessage")(function* (context: ActionContext) {
  if (!WorkflowActionTarget.guards.SlackChannel(context.step.target)) {
    return yield* slackInvalidTarget(context.step);
  }
  const writeKey = yield* requireSlackWriteKey(context.step);
  const receipt = yield* context.slack.sendMessage(
    context.step.target.channel,
    stringInput(context.step, "message"),
    writeKey,
  );
  return slackArtifact(context, receipt);
});

const replyInThread = Effect.fn("WorkflowActionPlan.replyInSlackThread")(function* (context: ActionContext) {
  const target = yield* requireSlackMessage(context.step);
  const writeKey = yield* requireSlackWriteKey(context.step);
  const receipt = yield* context.slack.replyInThread(target, stringInput(context.step, "reply"), writeKey);
  return slackArtifact(context, receipt);
});

const addReaction = Effect.fn("WorkflowActionPlan.addSlackReaction")(function* (context: ActionContext) {
  const target = yield* requireSlackMessage(context.step);
  const emoji = parameterValues(context.step.parameters, "emoji").at(0);
  if (!emoji) return yield* slackInvalidTarget(context.step);
  yield* context.slack.addReaction(target, emoji);
  return null;
});

const draftReply = Effect.fn("WorkflowActionPlan.draftSlackReply")(function* (context: ActionContext) {
  const target = yield* requireSlackMessage(context.step);
  yield* context.slack.draftReply(target, stringInput(context.step, "reply"));
  return null;
});

const slackEntry = (
  row: WorkflowCatalogEntry,
  target: TargetProducer,
  execute: ActionExecutor,
): ActionEntry => ({
  row,
  target,
  execute,
  phase: "write",
  tools: [],
});

export const slackWriteActionEntries = [
  slackEntry(slackActionRows.sendMessage, slackChannelTarget, sendMessage),
  slackEntry(slackActionRows.replyInThread, slackItemTarget, replyInThread),
  slackEntry(slackActionRows.addReaction, slackItemTarget, addReaction),
  slackEntry(slackActionRows.draftReply, slackItemTarget, draftReply),
];
