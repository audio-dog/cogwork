# Contracts glossary: Operations

Part of the [contracts glossary](./GLOSSARY.md).

**Operation**:
One unit of agent work in a Workflow: each Run executes one Operation, with one Work item's context in and one typed **Operation result** out. An Operation has no kind — any registered Harness runs any Operation — and the one thing that varies is its **permission profile**. Triage, implement, and follow-up are the coding pipeline's Operations.
_Avoid_: Lifecycle stage (retired), stage, step, task type, Operation kind

**Permission profile**:
What an Operation may do to files — `read-only`, the default, or `full` — and so the checkout the engine gives it: a scratch directory when no Workspace applies, the Workspace's own checkout for `read-only`, and a branch worktree for the item for `full`. A `full` Run in the person's own checkout cannot be expressed.
_Avoid_: Sandbox policy (the Tool, file, and network rules), Operation kind, checkout mode

**Operation definition**:
An Operation's contract, as its Workflow document states it: its Operating Instructions, permission profile, required needs, **questions**, **agent inputs** and their hints, and whether it answers once or for each finding (**fan-out**). The person — or an agent they work with — authors it. A required need names a concrete identity — an MCP server, a Skill, a Connection — and requiring never narrows what else a Run receives. The engine adds the needs the Operation's Triggers, actions, and resource references imply; the author never writes those.
A required need that cannot be satisfied — including a required Connection or MCP server that is not ready — is a Run Plan rejection, uniform across kinds. Rejection is recorded with its reason, but it is a fact about the machine's readiness, never a failed attempt: it does not move the item toward exhaustion, and it never parks the item waiting for a human. The item waits in view with the reason and is admitted when the need is ready. A failed attempt is work an agent was given and could not do.
_Avoid_: Playbook, run plan, operation settings, Operation kind

**Operation settings**:
The person's default Harness, model, and model options for every Operation, held at the Scopes the **Scope** table allows. They fill whatever an Operation's model choice in its document leaves empty and never outrank it: a default must never outrank a value that names the work. No setting names a user-authored Workflow, because its document already holds what the Workflow and Operation levels held; its permission profile, required needs, and on / off have no override. A Plugin only offers, and can never mark itself required for an Operation it does not own.
_Avoid_: Playbook, operation definition, run plan, target (say default / Workflow / Operation)

**Question**:
What an Operation's author asks the agent to decide, with a closed set of **choices**; the agent's pick is its **answer**, and Transitions route on answers. The engine adds what an author never writes: the `stuck` flag, and — when an action takes its Workspace from the agent — the Workspace the element is about. Each Action entry's Workspace source decides this: an `item-else-agent` action takes the Workspace of an issue or pull request item from the item, and takes it from the agent only when the item has no Workspace; an `agent` action always takes it from the agent.
_Avoid_: Outcome (overloaded — say answer, or Operation result for the whole value), route condition, enum, disposition

**Agent input**:
A field the agent fills in its result for an output action to use — `issue_title`, `pr_body`, `review_comments`. It is a required string, or a list of one engine-defined shape (a review line comment). It is empty when no matched Transition uses it, and refused at decode when a matched Transition needs it and it is empty. Its **hint** is the author's guidance for it, one per field, so two actions that share a field share one value and one hint.
_Avoid_: Output field, template variable, parameter (the author sets that)

**Fan-out**:
An Operation that answers *for each* finding instead of *once*. Its result is a list of **elements**, up to an engine cap, each with its own summary, answers, and agent inputs; each element becomes a child Work item that the engine routes by itself, and an empty list means there is nothing to do. The engine does the split; the author writes only the cardinality.
_Avoid_: Split, map, batch, loop

**Transition**:
What follows one combination of an Operation's answers: the **output actions** to perform and at most one **hand-off**. A Transition is identified by the answers it matches, and the engine owns the routing. Every combination must reach a Transition that does something — *Stop* is how an author says "nothing" — or the document cannot be published; when several Transitions match, their actions join, and together they may name only one hand-off. A failed Run follows the engine's own failure path — retry, then exhaustion, then a park — on which an author cannot route yet.
_Avoid_: Route (the prototype's word), edge, branch, workflow step, condition (a Trigger entry kind), Operation

**Hand-off**:
A Transition passing its Work item to another Operation of the same Workflow. A Transition has at most one, because a Work item holds one Claim; the next Operation reads the item again at its own admission and also receives the previous Operation's result. An Operation never hands off to itself, and every hand-off is a **hop**.
_Avoid_: Route, next step, *hand off to a person* (the older sense — say **park**), Trigger (the other way to start an Operation, through an artifact)

**Output action**:
One write a Workflow makes on a shared system — create an issue, open a pull request, post a review, reply in Slack, add a label — named on a Transition by its action entry and parameter values. The engine performs every output action; an agent never writes to a shared system itself. Each acts through the person's **Connection** for its app, so a Workflow acts as the person, within what the person published.
_Avoid_: Tool (an agent calls that during a Run), side effect, step

**Action plan**:
The frozen, typed list of writes that one element's matched Transitions produce, recorded before the first write: each step's action entry, parameters, agent inputs, target, and write key. The engine runs it in a fixed order — approval, then writes in document order, then *Notify me*, then the hand-off or *Stop* — and a write key makes a repeated step do nothing. A failed write never runs the agent again: a retryable one is tried again later, and a permanent one parks the item with `write-failed`, whose handback runs the rest of the plan.
_Avoid_: Run Plan (the resolved input of one Run), outbox, script, batch

**Operating instructions**:
Reusable guidance an agent must follow when performing an operation, resolved separately from the work-specific facts supplied for one run. For a Workflow Operation they are the **Operating-instructions package** it names, if any, and its inline instruction, with the engine's short framing and the Operation's questions and hints in the same layer — last and highest, above every Rule.
_Avoid_: Skill, playbook skill, prompt, work context

**Work context**:
The work-specific facts supplied to a run, in one frozen shape for each item kind: an issue's body and comments; a pull request's description, review comments, checks, and changed files, but never its diff; a Granola transcript; a Slack message or conversation with its thread; a schedule tick's fire times. It also records which Trigger fired and when, and the artifacts this item's lineage already created. After a hand-off, the next Operation gets the item read again plus the previous Operation's result. No source has options: one shape per kind.
**The engine supplies them; the agent never fetches its own brief.** The work item's prose — and, for follow-up, its pull request's description and review comments — is read once, at admission, and frozen into the Run Plan, so a Run starts with its brief and a tracker MCP server is at most optional context. A steer posted mid-Run reaches the next round, not this one. See ADR 0030.
_Avoid_: Operating instructions, prompt template, workflow settings

**Resource reference**:
A typed pointer from frozen Work Context prose to one resource in an external system, such as a Figma frame, derived by the Engine at admission. Each one makes a ready MCP server that **reads** its system a required need of that Run. A server only declares which systems it reads, so the requirement stays the Engine's and no Plugin marks itself required.
_Avoid_: Link, attachment, design spec, conditional need

The relationship is:

```text
Workflow                         (id and on / off live outside the document)
└── Workflow document            (working copy → published revision)
    ├── Workspace selection
    ├── Triggers
    │   └── Trigger entry + parameters → start Operation
    └── Operations
        └── Operation
            ├── Operation Definition
            │   ├── Operating Instructions
            │   ├── permission profile
            │   ├── required needs
            │   └── questions, agent inputs, cardinality
            ├── model choice     (empty parts filled by Operation Settings)
            └── Transitions      (the answers each matches)
                ├── output actions
                └── hand-off     (at most one)

Trigger event → Work item → selected Operation + Work Context
    → Run Plan
      ├── Harness Adapter
      ├── Instructions        (Operating Instructions + resolved Rules)
      ├── Tools
      ├── Skills
      ├── MCP
      ├── Subagents
      ├── Hooks
      ├── Middleware
      ├── Sandbox (Workspace, Policy)
      ├── Structured Output
      ├── Persistence
      ├── Connections
      └── Provenance
    → Run
    → Operation result → Action plan → output actions
```

**Priority**:
One of `urgent`, `high`, `medium`, `low` — a four-level scale (`priorityRank`, highest first) that orders work *within* an operation and nowhere else. Operation is always the primary sort key, so a low-priority follow-up still runs before an urgent implementation; priority only breaks ties between items selected for the same operation, and stable tracker order breaks ties between items of the same priority. Every observed item carries a resolved priority. Each adapter reads its own tracker's field and maps it onto this scale (`resolvePriority`, case-insensitive); anything absent, blank, or unrecognized becomes the `defaultPriority`, `medium`. Priority orders work — it never gates eligibility — so a value we can't read must never drop an item; it just lands in the middle.
For GitHub, `issueTracker.priority.field` is the stable numeric ID of an organization single-select issue field. Clients fetch the compatible catalog through the workspace's bound Connection and store a selection; they never ask a person to type GitHub coordinates. The adapter reads that ID from the issue-field values included with each listed issue. For Linear, priority is native and needs no configuration.
_Avoid_: Operation priority (that's the fixed operation order), severity, weight, rank (alone — `priorityRank` is the ordering, priority is the value)

**Triage role**:
A label value a coding Workflow's Triggers can match and its Transitions can add, such as `needs-triage` or `ready-for-agent`. The engine gives the value no built-in meaning.
_Avoid_: Status, state, label (when you mean the role's meaning)

**Requirements digest**:
The requirement details triage resolves from a work item's linked artifacts — final copy, design node links, decisions made in chat threads — and inlines into its proposal, so the work item becomes a self-contained brief. Context acquisition is triage's job, done once; an implement Run consults an external system only where the digest points at it. See ADR 0029.
_Avoid_: Brief (the whole item and thread — the digest is the part triage adds), work context (the engine-supplied facts, not tracker content), triage proposal (the digest rides in it)

**Review requirements**:
The judgment reviews a work item's shape demands, named by triage in its proposal and honored by the implement Run. Selection, never exemption: the security review runs on every diff regardless of what triage named. See ADRs 0027 and 0029.
_Avoid_: Review policy, gate (the local gate is checks, not reviews), required needs (the Operation definition's contract, not per-item flags)

**Blocked / blocker / blocking**:
An item is *blocked* when its issue tracker reports one or more open **blockers** — upstream items that must close before it can be worked — and it is *blocking* the items downstream of it. Blocking is the issue tracker's own dependency relation (GitHub issue dependencies today; Linear blocking relations when its adapter reads them), read per adapter. A blocked item is held out of the implementation operation until its blockers close, then becomes eligible on its own — no human acts. Neither eligible, claimed, nor needs-human.
_Avoid_: Depends-on (the inverse framing); needs-info / ready-for-human (those are needs-human — a person clears them); stuck / exhausted / stalled (failure outcomes, not dependencies).
