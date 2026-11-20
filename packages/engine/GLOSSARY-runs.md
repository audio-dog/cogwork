# Engine glossary: Runs

Part of the [engine glossary](./GLOSSARY.md).

**Workflow runner**:
The unit that executes one admission: claim, prepare the Run, resolve and persist the Run Plan, dispatch the Harness, record events, decode the document-derived Operation result, freeze and execute the Action plan, then complete the Run and route a hand-off or Stop. It orchestrates; the decisions sit in **Run Plan resolution** and **Run completion**.
_Avoid_: Executor, fixed pipeline, stage runner

**Run preparation**:
The step between claim and dispatch that ensures the checkout, chooses the Session, provisions the instruction layers, runs Harness preflight, and gathers the facts Run Plan resolution decides over. It owns every side effect a Run needs before it starts; it makes no decision about the Plan's contents.
_Avoid_: Setup, bootstrap, Run Plan resolution (the decision this step feeds)

**Run completion**:
The decision, taken from a Run's result and the item's coordination view, of what follows: retry, exhaust, park stuck, fan out, complete, or hand off. One decision serves a fresh Run, a resumed Action plan, and a review-plan refresh, so the failure counters and park reasons are applied in one place. An accepted Run always settles. A typed failure or a defect after the Claim is an input to this decision. It records one failed attempt and settles the Run `failed` or `exhausted`. An interruption settles the Run `interrupted` and records no attempt (ADR 0016).
_Avoid_: Outcome handling, completion closure, failure policy (one input to it), disposition

**Refused result**:
The typed reason the engine does not accept an **Operation result**. Its kinds are: the result does not match the schema (each issue's path and message), the action plan refuses it (the plan's message), pull request readiness declines it (the readiness reason), and the Harness stream fails before it gives a result. Each kind has two renderings. The agent text tells the next attempt what to change, through the `previous-result-issues` Run Plan resource. The person text is plain language for the attempt record and the `Exhausted` park reason that Attention shows; it never holds an Effect `Cause` dump. A refused result is a failed attempt, so three in a row make the item *exhausted*.
_Avoid_: Refused claim (a claim coordination will not accept), decode issues (only one kind), error string

**Run recorder**:
The one seam a run's harness events cross between the harness runner and everything that reads them. Recording is one act with four parts: assign the event's sequence, encode it as a run event, append it to the run ledger (capturing an opaque session handle when one rides the event), and publish the same moment as run activity. Reads come back through the same seam — a settled run replays as run activity for the drill-in, and a session's events decode for the transcript fold — so live and replayed activity are identical by construction. The recorded-event codec is shared only with the replay harness, which needs the same decode boundary.
_Avoid_: Run ledger (the store it writes to), daemon event bus (the transport it publishes on), event log, persistence (the TanStack adapter the session store hands the provider runner)

**Session store**:
The place sessions are minted and the read model a runner pulls a session's history from, given a `SessionId`. `mint` takes a harness name and the harness service's kind lookup, chooses the session kind from that runner's declaration, and inserts the row — owned-transcript for the provider runner (the run ledger holds the conversation), opaque-handle for a CLI harness (the harness holds its own history, with a null handle until one is captured). The Workflow runner asks for a session and never names a kind itself. It hands the provider runner a real `@tanstack/ai-persistence` adapter (`persistence`) that the runner runs under via `withPersistence`. Its **message store** is a ledger projection: `loadThread` folds the session's transcript out of the run ledger — every event across the runs that share the session (oldest run first), including terminal structured results, projected into ordered model messages — and `saveThread` is a no-op, because the run recorder already appends every event, so the event-sourced ledger stays the one source of truth. Beside the message store sit process-scoped **run** and **interrupt** stores that wire durable pause/resume ahead of the interactive phase; they live in memory, matching the run ledger's own durability, and a persistent ledger backend will carry them too. `resumeHandle` still hands back the session's opaque handle, the thing a CLI runner needs to resume its own history. An empty transcript is `[]` and an unhandled session is a null handle, never a failure. There is no second transcript store: the run ledger is the only place a conversation lives.
_Avoid_: Message store (that's the persistence library's term for the one piece of the adapter), transcript database, second store

**Session resume**:
A new Run and new native invocation that continue an existing Session. Cogwork sends the Session's `SessionId` as TanStack `threadId`; an opaque native handle, when present, goes only into the adapter's native `modelOptions.sessionId`. A resume never continues the old Run.
_Avoid_: Retry (why the new Run started), replacement Run (one recovery reason), Run takeover (continuation of the same invocation)

**Retry**:
The control plane starting another Run after a retryable failure. The new Run can resume the failed Run's Session, but retry describes failure policy, not conversation identity. A retry waits for the retry delay after each failed attempt: one minute after the first failure, two minutes after the second.
_Avoid_: Session resume, replacement Run, Run takeover

**Replacement Run**:
The new Run started after an interrupted or crashed Run. It can resume the same Session, but it starts a new native invocation with a continuation Message that treats the prepared Worktree as ground truth.
_Avoid_: Retry (interruption and crash are not attempts), Run takeover

**Run takeover**:
A successor driver adopting the same live native invocation and continuing the same Run after driver loss. It requires an exact delivery log, persistent native status, durable cancellation, distributed locking and fencing, and scheduled reaping. Cogwork does not enable it.
_Avoid_: Session resume, retry, replacement Run, human attach

**Harness switch**:
A run selecting a different harness from the branch's latest session. It begins a new session with the full operating instructions while preserving the worktree, branch, code progress, claim, and historical run records; only conversation continuity is discarded. Switching back never resurrects an older session from that harness.
_Avoid_: Session migration, session transfer, cross-harness resume

**Run Plan resolution**:
The decision that combines the published Operation, Default settings, Operating Instructions, Work Context, contributions, Sandbox Policy, and the tool needs its Action entries declare into one immutable Run Plan — or into a **Run Plan rejection** with its reason when the machine cannot satisfy the Operation. It decides over facts Run preparation gathered and performs no side effect.
_Avoid_: Fixed Operation resolution, stage resolution, prompt assembly, decline (the runner's act on a rejection)

**Resource reference**:
A typed pointer from frozen Work Context prose to one resource in an external system, such as a Figma frame, derived by the Engine at admission. Each one makes a ready MCP server that **reads** its system a required need of that Run. A server only declares which systems it reads, so the requirement stays the Engine's and no Plugin marks itself required.
_Avoid_: Link, attachment, design spec, conditional need

**Action entry**:
One registered output action: its catalog row, the target it freezes, the write it performs, its phase in the Action plan's fixed order (approval, write, notify, terminal), and the engine Tools a Run needs to use it. Registered once under its full catalog key; the Trigger and action catalog's action rows derive from the registry, so a row cannot exist without its write. The row also gives the entry's **Workspace source**: where its target's Workspace comes from — the item, else the agent's choice (`item-else-agent`), or the agent's choice only (`agent`). The target producer reads the Workspace through that field, and the Operation result asks the agent for a Workspace only when the field says the agent chooses it.
_Avoid_: Action executor (one field), catalog row (one field), handler, action definition
