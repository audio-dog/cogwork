# Contracts glossary: Triggers

Part of the [contracts glossary](./GLOSSARY.md).

**Trigger**:
A Workflow's start rule: one Trigger entry, its parameter values, its **Trigger filters**, and the Operation it starts. Every Trigger is level-triggered: it fires once for each new **source revision** of a Work item. The parameters and filters on one Trigger must all match; any one Trigger of a Workflow may start it. An issue Trigger matches open issues only: a closed or canceled issue never matches, with or without a filter.
_Avoid_: Event (that is a **Trigger event**), Hook (a contribution kind), webhook, follow-up trigger (the fixed pipeline's wake conditions)

**Trigger filter**:
A catalog entry of kind *filter* that narrows a Trigger to items it holds for (*Issue is not blocked*). A filter belongs to one app and item kind, and a Trigger may name only filters of its own entry's app and item kind. The Trigger source decides it: it lists on each event the filters the item passes, and Trigger observation admits a subscription only when the event passes all of its filters. Before a Run claims an item at its Trigger's start Operation, the source checks the item again: a closed, gone, or unlabelled item is skipped with the reason, with no attempt and no park; an item that only fails a filter waits until it passes.
_Avoid_: Condition (a Trigger entry kind), parameter (an author-set value, not a test of the item), guard

**Condition / occurrence**:
The two kinds of Trigger entry. A **condition** (*Issue has label*) fires for every item that matches, including items that already match at switch-on; its source revision is the moment it became true. An **occurrence** (*New comment from a person*) fires only for events after switch-on, and events while the Workflow is off are skipped, never replayed. An entry's name states its kind.
_Avoid_: State / event, *filter* (that is a **Trigger filter**), *condition* for what a Transition matches (say its answers)

**Parameter**:
An author-set, typed value on a Trigger or an output action — a label, a channel, a schedule time, a review event — with fixed choices or a live list a Connection supplies. Only the author sets one; where the agent must choose, the author asks a **question** and routes on its answer.
_Avoid_: Option (that is a **model option**), *filter* (that is a **Trigger filter**), setting, argument

**Trigger source**:
The observer of one source — the issue tracker, source control, Granola, Slack, or the clock — that emits Trigger events for its subscriptions. It sees subscriptions (an entry, its parameter values, and its Workspaces), never Workflows, and writes nothing; the engine admits its events and pairs them with Triggers. Receiving events instead of polling is a change inside one source, never a second model.
_Avoid_: Sensor (the self-correction layer's health watcher), connector, listener, webhook

**Source revision**:
The value from a source that moves only when its event happens again — a newest comment id, a head SHA, a Granola update time, a Slack `ts`, a scheduled instant. Each Work item carries an observed and a processed source revision and is eligible when the first is ahead and no claim is held, so edits during a Run combine into one next Run. The engine owns revisions; no author writes one.
_Avoid_: Bare *revision* (a Workflow has a **published revision**), version, watermark (a read position, not the authority)
