# Engine glossary: Triggers

Part of the [engine glossary](./GLOSSARY.md).

**Catch-up window**:
An occurrence entry's parameter that bounds how far back its Trigger source reads after the daemon was down. Events older than the window are skipped, and the read model reports them.
_Avoid_: Replay window, backfill

**Quiet period**:
An ambient Slack Trigger's parameter: how long a conversation must stay silent before the Trigger fires, so one Run reads a finished exchange. Beside it, *at most every* bounds how often one conversation fires.
_Avoid_: Debounce, delay, cooldown (that is *at most every*)

**Sweep**:
A schedule Trigger with a selector over Work items that already exist — their source, state, and idle time — that gives each selected item one Run. Each sweep starts a new lineage, and the idle time bounds how fast it can repeat.
_Avoid_: Batch, cron job, scan
