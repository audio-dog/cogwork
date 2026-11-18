# Engine glossary: Triggers

Part of the [engine glossary](./GLOSSARY.md).

**Trigger event**:
One observation a Trigger source makes: the Work item it names, that item's new source revision, its **cause**, and its time. A redelivered event names a revision already seen and starts nothing.
_Avoid_: Webhook, delivery, notification, Daemon event (the client feed)

**Origin record**:
The engine's record on each artifact it creates — an issue, a pull request, a comment, a Slack post — naming the Work item and Run behind it. Cogwork writes through the person's account, so the account cannot tell Cogwork's writes from the person's; the origin record does. It decides a Trigger event's **cause** and carries lineage across Workflows, and a Slack post Cogwork made never moves the source revision of the conversation it lands in.
_Avoid_: Bot marker, actor check (the account cannot decide), provenance (the Run Plan's stamp)

**Sweep**:
A schedule Trigger with a selector over Work items that already exist — their source, state, and idle time — that gives each selected item one Run. Each sweep starts a new lineage, and the idle time bounds how fast it can repeat.
_Avoid_: Batch, cron job, scan

**Catch-up window**:
An occurrence entry's parameter that bounds how far back its Trigger source reads after the daemon was down. Events older than the window are skipped, and the read model reports them.
_Avoid_: Replay window, backfill

**Quiet period**:
An ambient Slack Trigger's parameter: how long a conversation must stay silent before the Trigger fires, so one Run reads a finished exchange. Beside it, *at most every* bounds how often one conversation fires.
_Avoid_: Debounce, delay, cooldown (that is *at most every*)
