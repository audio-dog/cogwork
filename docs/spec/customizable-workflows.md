# Customizable Workflows — spec

The product and architecture spec for Workflows: a person's reusable automations, authored as data, over Triggers, Operations, Transitions, output actions, and human touchpoints. It is the destination artifact of [Wayfinder map: Customizable Workflows](https://github.com/colonylabs/cogwork/issues/656), settled between 2026-09-11 and 2026-10-28, and it resolves [Write the Workflows spec](https://github.com/colonylabs/cogwork/issues/660). The tracker copy is [Spec: Customizable Workflows (#797)](https://github.com/colonylabs/cogwork/issues/797), labelled `ready-for-agent`; this file is the same spec in full. Where the two differ, this file is current.

Every decision below has a source: a closed ticket on the map, a research document on a `research/*` branch, or a merged pull request. Each section names its ticket; the ticket's resolution comment holds the full reasoning, rejected options, and prior art. **This document is the index and the handoff — the tickets and the research are the depth.** Where this spec settles a question the map left open, it says so. The vocabulary is [`packages/contracts/CONTEXT.md`](../../packages/contracts/CONTEXT.md) after [#796](https://github.com/colonylabs/cogwork/pull/796); where this spec and the glossary disagree, the glossary wins.

## Problem Statement

Cogwork runs one fixed pipeline: triage → implement → follow-up, over issues in a tracker. The pipeline is engine code. A person cannot change what starts it, what the agent decides, or what Cogwork does with the answer. They cannot make Cogwork act on a meeting transcript, a Slack message, or a schedule. They cannot add a human checkpoint where they want one, or remove one they do not need. The only way to change Cogwork's behaviour is to change Cogwork.

The person also has no way to see, in one place, where the pipeline waits for them and why, and no way to answer in place.

## Solution

Workflows: a person's reusable automations, authored as data. A Workflow is one or more **Triggers**, the **Operations** they start, and the **Transitions** that route each Operation's typed answers to engine-owned **output actions**, a **hand-off** to the next Operation, or a **human touchpoint**. The engine observes the sources, owns the routing, performs every write, and holds every item that waits for a person.

Every author — the desktop editor, a shipped **Workflow template**, a future chat agent — writes the same schema-validated **Workflow document** through the same command RPCs. The engine runs only what a person publishes.

Cogwork ships four templates: the coding pipeline, Granola → Issue, Slack → Review, and a Staleness sweep. The fixed pipeline migrates onto this system and is deleted. **Granola → Issue is the first Workflow the build proves the engine on.**

## User Stories

### Authoring

1. As a person, I want to create a Workflow from a template, so that I start from something that works.
2. As a person, I want to see only the templates that fit the Connections I have, so that I am not offered a Linear template with no Linear.
3. As a person, I want to author a Workflow from nothing in the desktop editor, so that I can automate work no template covers.
4. As a person, I want every Trigger, action, and option I can choose to come from one list the engine owns, so that I can never name something the engine cannot do.
5. As a person, I want to choose which Workspaces a Workflow observes and acts in — every one, a listed set, or none — so that a Workflow stays in its lane.
6. As a person, I want to write what each Operation must decide as a question with a closed set of choices, so that the agent's answer is typed and I can route on it.
7. As a person, I want to write what each Operation must produce for an action — an issue title, a review body — as a named input with my own hint, so that the agent writes what the action needs.
8. As a person, I want to say whether an Operation answers once or for each finding, so that one transcript can become many issues.
9. As a person, I want to choose the Harness, model, and model options for each Operation, or leave them empty and inherit my defaults, so that I control what I pay for.
10. As a person, I want to choose whether an Operation may change files, so that a read-only judgement never gets a worktree.
11. As a person, I want to require a concrete MCP server, Skill, or Connection for an Operation, so that a Run never starts without what it needs.
12. As a person, I want to name a first-party Operating-instructions package for an Operation and add my own instruction, so that the coding Operations keep their shipped guidance and I can still tune them.
13. As a person, I want the editor to tell me what is malformed, what blocks publish, and what is only advisory, each at the node it concerns, so that I know what to fix and what I can ignore.
14. As a person, I want an incomplete Workflow to save as I work, so that I never lose an edit because a hand-off is not wired yet.
15. As a person, I want to publish a Workflow as a separate act from editing it, so that nothing I am still changing can run.
16. As a person, I want to switch a Workflow on and off without changing its document, so that stopping it is one click and restarting it needs no re-publish.
17. As a person, I want to delete a Workflow I made from a template, so that a template I tried does not stay with me.
18. As a person, I want an app update to leave my Workflows alone, so that nothing I published changes under me.
19. As a person, I want to see "Operation X will run two times" when a Transition both hands off to X and fires a Trigger that starts X, so that I understand the shape I built.
20. As a person, I want two Workflows to compose through what they create — an issue one makes starts another — so that I build small Workflows, not one large one.

### Observing

21. As a person, I want a Workflow to fire once for each new event and never again for the same one, so that a redelivered event or a daemon restart does not repeat work.
22. As a person, I want a condition Trigger ("Issue has label") to pick up items that already match when I switch the Workflow on, so that my backlog is covered.
23. As a person, I want an occurrence Trigger ("New comment from a person") to skip events that happened while the Workflow was off, so that switching on does not replay a month of history.
24. As a person, I want to see how far back a Trigger reads after the daemon was down, and change it, so that I decide what "missed" means.
25. As a person, I want a Granola Workflow to act on a note when its summary and transcript exist, so that the agent never reads a partial transcript.
26. As a person, I want a Slack Workflow to wait until a conversation goes quiet before it acts, and to act at most so often on one conversation, so that it reads a finished exchange and does not nag.
27. As a person, I want a Slack Workflow to start when I am mentioned, in every channel or in one I choose, so that my own name is the signal.
28. As a person, I want a Slack message that Cogwork posted never to wake Cogwork again, so that a Workflow cannot talk to itself.
29. As a person, I want a scheduled Workflow to fire at a wall-clock time in my zone and to catch up once after downtime, so that a nightly sweep runs nightly.
30. As a person, I want a sweep Workflow that gives each parked or idle item its own Run, so that stale work is judged one item at a time.
31. As a person, I want to see which Workspaces a Trigger observes in and which it skips, with the reason, so that "observes in 3 of 5 Workspaces" is not a surprise.
32. As a person, I want a Connection that is not ready to stop its Trigger source and show me why, with no failed attempt, so that machine state is never counted as agent failure.
33. As a person, I want to connect Granola with the browser login and add an API key when my plan has one, so that the Trigger works on every plan and gets faster when it can.
34. As a person, I want to connect Slack by creating an app in my workspace from a manifest Cogwork gives me and pasting its tokens, so that Cogwork reads at full rate and needs no public address.

### Running

35. As a person, I want each Run to see the item's prose — the issue and its comments, the transcript, the message and its thread, the pull request's description, review comments, checks, and changed files — frozen once, so that the agent starts with its brief.
36. As a person, I want the next Operation after a hand-off to receive the item again plus the previous Operation's answers and inputs, so that nothing it decided is lost.
37. As a person, I want an Operation that creates or comments on issues to get a read-only issue search Tool over my trackers, so that it can tell new work from a duplicate.
38. As a person, I want an Operation that acts on a named pull request to get a read-only pull request Tool, so that it can read the diff without a checkout.
39. As a person, I want the agent to choose which Workspace a transcript or message is about, from the Workflow's selection, or to say "none recognized", so that Cogwork never files an issue in a repository it does not recognize.
40. As a person, I want a fan-out element whose plan needs a Workspace, and that recognizes none, to park before any write and show me what it planned, so that a wrong guess costs nothing.
41. As a person, I want the agent to be able to say it is stuck on any Operation, so that it halts itself rather than guess.
42. As a person, I want a result the agent returns in the wrong shape to be retried with the exact decode problems shown to it, so that the second attempt can fix the first.
43. As a person, I want a Run that fails to retry while the failure is retryable, and after three in a row to park the item with the reason, so that a failing Run cannot spend my budget without limit.
44. As a person, I want a loop in my own Workflow — follow-up pushes, CI fails, follow-up runs — to stop after a cap of hops and park the item, so that no cycle runs forever.
45. As a person, I want the engine to push the branch and open the pull request, so that no agent writes to a shared system itself.
46. As a person, I want "Open a pull request" to refuse when the head is not ahead of the base, and to tell the agent why on the retry, so that an empty pull request is never opened.
47. As a person, I want every write a Run causes to be a frozen plan recorded before the first write, so that a failed write never runs the agent again and a retry never creates the artifact twice.
48. As a person, I want each artifact Cogwork creates to carry an origin record, so that Cogwork recognizes its own writes even though it writes as my account.
49. As a person, I want every output action to act as me through my Connection, so that Cogwork does my work with my accounts within what I published.
50. As a person, I want no merge and no delete in the catalog today, so that the irreversible acts stay mine.

### Reviewing with Slack → Review

51. As a person, I want a review Operation to post a review as approve, comment, or request changes, with line comments on the new side of the diff, so that a review Cogwork drafts reads like one I wrote.
52. As a person, I want to decide, as author, which review events the agent may post, so that the engine sets what can happen and I set what does.
53. As a person, I want a line comment on a line that is not in the diff to be refused at decode, so that a review never lands on the wrong line.
54. As a person, I want a frozen review plan to be withdrawn when new commits land, so that a review never describes an old head.
55. As a person, I want "Draft a review" to leave a pending review only I can see, so that I can submit it in GitHub as my own.

### Human touchpoints

56. As a person, I want to route any answer to "Notify me" and see the element's summary, the matched answers, and links to what the plan created, so that I am informed without being blocked.
57. As a person, I want to route any answer to "Wait for my approval" and have the whole plan wait, so that I gate what I choose to gate and nothing else.
58. As a person, I want to approve a plan by its digest, edit the agent's text and approve the new digest, reject it with a note, or hand it back with a note, so that each act names exactly what it acts on.
59. As a person, I want a plan that waits for approval to be withdrawn when the item changes at its source, so that I never approve something stale.
60. As a person, I want to route any answer to "Hand to me", so that the item waits for me with no label semantics the engine must know.
61. As a person, I want to choose an answer on a handed-to-me item and supply any input the chosen Transition needs, so that the engine builds and runs the plan as if the agent had answered.
62. As a person, I want a handback to resume the Operation that parked, with my note in its prompt, so that "I fixed the credentials" reaches the agent.
63. As a person, I want a handback after a failed write to run the rest of the plan, not the Operation, so that completed work is not redone.
64. As a person, I want one Attention page with lanes for what needs me, what notified me, and what Cogwork skipped, so that nothing waits where I cannot see it.
65. As a person, I want each parked card to show the Workflow and its published revision, the Operation, the lineage across hand-offs and Workflows, the element summary, and whether the item changed since it parked, so that I can act with context.
66. As a person, I want an OS notification for every park, whose click opens that card, so that I learn Cogwork needs me while I work elsewhere.
67. As a person, I want "Ready to merge" to be a view of Cogwork-opened pull requests that are green, conflict-free, and approved, with no model involved, so that merge stays mine.

### Migrating

68. As a person, I want the coding pipeline to become a template I own, so that I can change how triage decides and what follow-up does.
69. As a person, I want a reporter's answer on a `needs-info` issue to start triage again with no relabel, so that the conversation moves on its own.
70. As a person, I want the cut-over to be one pull request I can revert, so that a bad release costs one revert.

### A future agent

71. As a person, I want to set up a Workflow later by talking to an agent inside Cogwork, so that I never have to learn the editor.
72. As an authoring agent, I want to read the catalog, the templates as examples, and the validator's diagnostics as data, so that I can write and correct a Workflow without a person reading errors to me.
73. As an authoring agent, I want to edit the same working copy the person edits and to see their edits since my last turn, so that we work on one document.
74. As an authoring agent, I want publish and switch-on to be a person's acts, so that nothing I write runs until the person decides.

## Implementation Decisions

### 1. Standing constraints

Every decision on the map was made under these, and the build keeps them:

- **One contract, many clients.** The app, the CLI, a future chat agent, an outside Harness over MCP, and a later Workflow all use the same query and command RPCs. No client gets its own commands, and the daemon does not check which kind of client called. ([Grill: the agent-authoring seam](https://github.com/colonylabs/cogwork/issues/783), item 1; ADR 0016)
- **The document is data, never code**, JSON-Schema-strict: no open-keyed maps, no recursion, shallow nesting, few optionals, at most one discriminated union, `additionalProperties: false`. The downstream result schema the engine derives must meet the same bar. ([Research: TanStack AI 1.0 surfaces](https://github.com/colonylabs/cogwork/issues/780), demands 2 and 10)
- **The document holds references, never display copies**: a catalog key, a `WorkspaceId`, an Operation id. Names, icons, and agent inputs are derived at read time. (#783 item 11)
- **Agents never write to a shared system.** Every write is an engine-owned output action. (Map notes)
- **The engine runs only what a person publishes.** Publish and switch-on are a person's acts. (#783 items 6 and 7)
- **Human gates are the author's choice.** The engine has no approval guard of its own. ([Grill: shipped default Workflows](https://github.com/colonylabs/cogwork/issues/790), item 17)
- **Models are for intelligence; the engine owns coordination.** Only "is this the same work?" and "which Workspace is this about?" go to the model; identity, dedupe, retry, caps, and routing are deterministic engine code. ([Grill: the item behind a Workflow Run](https://github.com/colonylabs/cogwork/issues/782))
- **Fix forward; keep nothing for compatibility.** Nothing is released, so a breaking change costs a migration of zero installs (`docs/agents/technical-disposition.md`, *Take the shape that survives the turn you can see coming*). When a ticket meets a choice between a clean shape and a shape that also reads the old one, it takes the clean shape: no union that still decodes a record with a missing field, no decoder for an old marker form, no cancel-on-read of old rows. A stored record or row that does not decode is ignored and reported; at worst an item gets three fresh attempts, and a Workflow row that does not decode is unreadable while the others load. The fixed pipeline's own records are current until the cut-over and are written in the new form from the first prefactor. Where a ticket says "resolve or drop", read "drop".
- **Every module is named by its interface, not its package.** §20 states the interface of each module the build creates: inputs, outputs, invariants, ordering, and error modes. A ticket builds behind that interface and tests through it. A module whose interface is as wide as its implementation, or that passes a call through to another module without adding a rule, fails the deletion test and is sent back (`/codebase-design`).

### 2. The Workflow document

The schema lives in `@cogwork/contracts` as an Effect Schema; the engine derives JSON Schema from it where TanStack needs one and decodes with Effect. The shape, as [Grill: the Workflow document](https://github.com/colonylabs/cogwork/issues/784) settled it and later grills amended it (the one decision-rich snippet this spec inlines):

```ts
WorkflowDocument {
  name: string
  workspaces: { _tag: "Every" } | { _tag: "Listed"; workspaces: WorkspaceId[] }   // the one union; Listed [] = none
  triggers: {
    id: Slug
    entry: CatalogKey                              // e.g. "github.issue-has-label"
    parameters: { id: string; value: string }[]    // canonical string form per parameter type
    start: OperationId
  }[]
  operations: {
    id: Slug
    name: string
    instructionPackage: string | null              // a first-party Operating-instructions package
    instruction: string                            // inline Operating Instructions
    permissionProfile: "read-only" | "full"
    requires: NeedIdentity[]                       // concrete identities; no binding
    model: { harness: HarnessName | null; model: string | null; options: { id: string; value: string | boolean }[] }
    forEach: string | null                         // null = once; a noun = for each ⟨finding⟩
    questions: { id: Slug; text: string; choices: { id: Slug; name: string }[] }[]
    transitions: {
      when: { question: Slug; choice: Slug }[]     // the answers it matches; its identity
      actions: { entry: CatalogKey; parameters: { id: string; value: string }[] }[]
      handOff: OperationId | null                  // at most one
    }[]
    hints: { field: string; text: string }[]       // one hint per result field
  }[]
}
```

- **Identity.** The Workflow id is engine-minted and lives on the Control store row, not in the document, so a document can travel between people. Node ids are author-chosen slugs, unique in the document, never changed after creation. A rename changes only `name`. (#784 items 12, 15)
- **Each Trigger names the Operation it starts.** Position in a list carries no meaning. (#784 item 7)
- **A Transition is identified by the answers it matches.** Two Transitions of one Operation with the same answers are malformed. Edits address a Transition by Operation id and answers. A Transition holds `actions` and at most one `handOff`, because a Work item holds one Claim. (#784 items 8, 9)
- **No deterministic Step node now.** Every node is an Operation. Triggers and Transitions address nodes by id, so a later Step kind adds a node member and changes neither. (#784 item 10)
- **Workspace selection is a field, not a Scope.** For a tracker or pull request Trigger it says where the Trigger source watches; for a Granola or Slack item it is the list of candidates the agent chooses from, plus "none recognized". A deregistered id is advisory and skipped. (#784 items 11–13)
- **Model choice has one authority per level.** For a user-authored Workflow the document is its Workflow and Operation levels. Each null part falls through to the Default-level Operation-settings rows, where the Scopes still apply. No Operation-settings row may name a user-authored Workflow. Permission profile, `requires`, and on/off have no settings override. Accepted cost: a Workspace cannot override a model the document names; to get per-Workspace control the author leaves it null. (#784 items 1–6)
- **`instructionPackage`** names a first-party Operating-instructions package (catalog data), resolved as today — Workspace override first (ADR 0019), then the engine package. Its entry point heads the Operating Instructions layer; the inline `instruction` follows. An unknown name is malformed. `empty-instruction` passes when either field has content. ([Grill: migrating triage → implement → follow-up onto Workflows](https://github.com/colonylabs/cogwork/issues/789), item 11)
- **A hint is keyed by result field**, not by action: GitHub and Linear "Create an issue" share `issue_title`, so one element writes one title and one hint guides it. ([Grill: the outcome contract](https://github.com/colonylabs/cogwork/issues/786), item 3)

### 3. Storage, working copy, published revision

- **One Control store row per Workflow:** the engine-minted id, the owning Principal, the working copy and its revision (+1 per applied edit batch), the published copy and its revision (null before the first publish), and on/off. Both document columns are strongly typed JSON with a validity check, decoded on every read and encoded on every write through the contracts Schema, so the daemon, the RPC, and the app all use one type. A row that does not decode makes that Workflow unreadable — reported, nothing runs from it — and the others go on. (#784 items 14, 16)
- **No revision history.** Each Run records the published revision it ran. (#784 item 17)
- **One shared working copy, changed by edits.** Nobody keeps a private copy. Every writer sends edits that name their target by stable id; the daemon applies them one batch at a time, in arrival order, to the current working copy, then publishes the new record to every client. A whole document enters only through `create`. The editor stops keeping its own draft and becomes a live view. (#783 items 2–3)
- **The agent saves without limit and reacts to the person's edits.** Each agent turn starts with the current working copy and the edits made since its last turn; the engine supplies them. (#783 items 4–5)
- **Publish names the revision the person sees** and refuses if an edit arrived first. On/off is a separate act keyed by Workflow id, stored by the daemon, not in the document. (#783 items 6–7)
- **Switch-off and delete decline; they never unwind.** Runs in flight finish, the next admission declines, items wait in view, coordination records stay. Occurrences while off are skipped and never replayed. (#784 item 20; [Grill: Trigger observation](https://github.com/colonylabs/cogwork/issues/787))
- **Each admission reads the current published revision.** A hand-off to an Operation the current revision lacks parks the item with `missing-operation`. (#784 item 19)
- **Sharing stays out of scope, but gets no harder:** export is get-the-published-copy; import is `create`; machine-bound references (Workspace ids, Connection identities, Harness) stay in named fields so a later import can ask the person to bind them again. (#784 item 18)

### 4. Commands, queries, events

- **Commands:** `create(document)` → id, revision, diagnostics · `edit(id, edits)` → new revision and diagnostics, or a refusal carrying them · `publish(id, revision)` · `switch(id, on | off)` · `delete(id)`. Each edit is a tagged struct naming its target by id; a function cannot cross the RPC. (#784 items 26–27)
- **Human-touchpoint commands:** `Approve`, `Reject`, `HandBack` (gains Workflow-item addressing, loses `role`, takes an optional note), `ChooseAnswer` (new). Each names what it acts on — a plan digest, a parked attempt — and refuses when that is no longer current. Any client may send them as the Principal. A Workflow Run never gets them as Tools. `Reclassify` and its CLI command are deleted at cut-over. ([Grill: output actions and human touchpoints](https://github.com/colonylabs/cogwork/issues/788), item 11; #789 items 14–16)
- **Queries:** `list` · `get(id)` (working copy, published copy, both revisions, on/off, diagnostics) · `catalog` · `validate(document)` · `templates` · `listOptions({ entry, parameter, workspaces })` → `{ value, name, listedIn: WorkspaceId[] }[]` with source failures as data. (#784 item 26; #788 item 3; #790 item 4)
- **Events:** `WorkflowChanged` carries one Workflow's whole new record; `WorkflowDeleted { id }` beside it; `list` seeds a new client. Not `ControlStoreChanged`: an agent edits at typing speed. (#784 item 28)
- **Responsiveness.** An edit is a local socket call, one SQLite write, and the pure validator. A click waits for the daemon's answer. A focused text field keeps its own text while the person types and sends one edit on pause or blur, then takes the daemon's value — field text, not a Workflow draft. The build sets a latency budget for the edit round trip (ADR 0023). (#784 item 29)
- **Acceptance test for the seam:** a client that has only the RPC can author every Workflow the editor can. (#783 item 10)

### 5. Validation and diagnostics

- **One validator, a pure function in `@cogwork/contracts`**: document and catalog **content** in, diagnostics out. The catalog it reads holds entries, instruction packages, and Harness model catalogs — never machine state. The daemon runs it on every create, edit, and publish, and its answer is final; the editor and the agent run the same function only to show problems earlier. **Advisory diagnostics that depend on the machine** — `connection-not-ready`, `need-not-ready`, `harness-unavailable`, `no-harness`, `workspace-not-registered`, `system-unbound`, `option-not-listed` — come from a second pure function, `adviseReadiness(document, catalog, machine)`, over a `MachineReadiness` snapshot the daemon assembles; they ride on the record as `readiness`, beside the document's `diagnostics`, and a machine change never republishes the Workflow (#783 items 8–9; §20). The document-only advisories (`unreachable-operation`, `hand-off-and-trigger`) stay in the validator.
- **A diagnostic carries a stable code, a location by stable ids, a message, and a class.** An unknown key is a diagnostic that names the key. A Connection that is not ready is never a fault in the document. (#783 item 9)
- **One rule: the working copy may be incomplete, never malformed.** Malformed refuses the whole edit batch (atomic). Incomplete blocks publish. Advisory never blocks. **Enable has no diagnostic gate**: it refuses only when no published revision exists; the switch result reports how many items match a condition Trigger now, as information. (#784 items 21–22)

| Class | Code | Meaning |
|---|---|---|
| Malformed | `schema` | Does not decode: unknown key (named), wrong type, missing field. |
| Malformed | `unknown-target` | An edit names a node that does not exist. |
| Malformed | `duplicate-id` | Two Operations, Triggers, or Questions share an id, or two Choices in one Question. |
| Malformed | `duplicate-transition` | Two Transitions of one Operation match the same answers. Renamed from `duplicate-condition`, because *condition* now names only a Trigger entry kind ([Update the contracts glossary for Workflows](https://github.com/colonylabs/cogwork/issues/791)). |
| Malformed | `unknown-reference` | A Transition names a missing Question or Choice, or `start` / `handOff` names a missing Operation. |
| Malformed | `self-hand-off` | An Operation hands off to itself. |
| Malformed | `unknown-catalog-entry`, `unknown-option` | The key, or a fixed parameter value, is not in the catalog; also an unknown `instructionPackage`. A parameter value that does not decode or is out of the entry's limits. |
| Malformed | `unknown-model` | The model or an option is not in the named Harness's managed catalog (ADR 0024), or a model is named with no Harness. |
| Incomplete | `no-trigger` | The Workflow has no Trigger. |
| Incomplete | `uncovered-outcome` | A combination of answers reaches no Transition that does something. Stays Incomplete: there is no run-time fallback, by design. |
| Incomplete | `conflicting-hand-offs` | The Transitions that match one answer combination name more than one hand-off. |
| Incomplete | `empty-instruction` | Neither `instructionPackage` nor `instruction` has content. |
| Incomplete | `missing-option` | A required Trigger or action parameter has no value. |
| Incomplete | `profile-too-narrow` | An action needs `full` on a `read-only` Operation. |
| Incomplete | `no-workspace` | An action needs a Workspace and the selection is `Listed []`. |
| Incomplete | `item-kind-mismatch` | A Trigger's item kind can reach an action that cannot act on that kind. |
| Advisory | `connection-not-ready`, `need-not-ready` | For a Trigger, an action, or a required need. |
| Advisory | `harness-unavailable`, `no-harness` | The named Harness is not available; or the document says null and no default row exists. |
| Advisory | `workspace-not-registered` | A listed Workspace was deregistered. |
| Advisory | `system-unbound` | No Workspace in the selection binds the entry's app (Trigger or action). |
| Advisory | `unreachable-operation` | No Trigger and no hand-off reaches the Operation. |
| Advisory | `option-not-listed` | A live parameter value the Connection does not list now. |
| Advisory | `hand-off-and-trigger` | A Transition hands off to X and its actions also fire a Trigger that starts X; X runs two times, one after the other. The engine does nothing special; clients show it. |

`needs-approval` (from #788) is deleted: every action acts as the person, so approval is the author's choice. (#790)

### 6. Work items, coordination, lineage

ADR 0033 ([#793](https://github.com/colonylabs/cogwork/pull/793)) records the coordination decision.

- **A Work item is the one thing a Run acts on.** A tracker supplies it, or the engine mints it from a Trigger event. Identity derives from an immutable source identity; the author writes no key: issue → `WorkItemId`; pull request → the linked item by link key, else its own item; Granola → `note_id` under its Connection (revision `updated_at`); Slack → `(team_id, channel, ts)`, or for an ambient conversation `(team, channel, thread_ts)` / the first message's `ts`; schedule → `(Workflow, scheduled instant)`; fan-out child → parent item + Run + element position. (#782; #787)
- **One coordination interface, two adapters.** Tracker items keep ADR 0003. Engine-minted items keep the same Claim, Attempt record, and Handback record shapes in the Control store, outside the Run ledger's disposable region, append-only (engine ADR 0011). Classification, the failure limit, and the handback barrier never branch on where an item came from: they hold a `WorkItemRef`, and the `Coordination` module in §20.2 chooses the authority inside.
- **Level-triggered.** An item is eligible when its observed source revision is newer than its processed revision and no claim is held. A redelivered event starts no Run; edits during a Run combine into one next Run.
- **Fan-out.** An Operation declares `once` or `for each ⟨finding⟩`. The engine splits the list and routes each element by itself; an empty list means nothing to do. A child is a full Work item with its own id (never a key from model output). List cap 50, enforced at decode. (#782)
- **Dedupe has three layers:** the revision (exact, engine); the write key on each output action (engine; a retry after success never creates the artifact twice); and the model's "is this the same work?", which the author routes on and the engine makes answerable (Work context carries the artifacts this lineage already created; the issue search Tool). (#782; #788 item 5)
- **Lineage.** Every Claim and Attempt record carries a required `lineage: { root, parent, hop }` — the root, the parent hop, and **this hop's depth**, written by the engine when it claims (the parent's depth plus one, or zero at a new root). A hand-off, a fan-out child, and an event whose cause is Cogwork's own write (found through the origin record) keep the lineage; an event a person caused, a schedule tick, and a sweep start a new root. A record with no lineage does not decode and is ignored (fix forward). (#782; #787; §20)
- **Hop cap 25 per lineage**, engine policy, a fourth failure counter that takes the handback barrier at engine ADR 0011's one composition point. A hop is a hand-off, a fan-out child, a Workflow start that inherits a lineage, **or a Run admitted on a source revision the lineage itself caused** (follow-up pushes, CI fails on the new head, follow-up runs again). A revision a person causes starts a new root. Because depth is stored on the record, the cap is a field read, never a search across items. Reaching the cap parks with `hop-cap`. Accepted: 25 rounds can cost a lot; a separate per-Operation round cap can come later. (#782; #789 item 7)
- **Order of waiting work** replaces engine ADR 0009's stage key: items this Workflow already acted on (a succeeded attempt) first, then priority, then the oldest observed revision. (#789 item 8)
- **The assignee allowlist (engine ADR 0008) stays a Workspace setting**, applied by the tracker and source-control Trigger sources before the matcher, for every Workflow over that Workspace. (#789 item 4)

### 7. Trigger observation

- **Every Trigger is level-triggered on a source revision**: a value from the source that changes only when the event happens again (newest comment id, head SHA, head SHA plus check conclusion, review id, merge or close time, the label-applied moment, Granola `updated_at`, Slack `ts`, the scheduled instant). A Trigger fires once per new revision of a Work item. The engine owns revisions; the author writes none. Pushed events join later as a second transport that makes a Trigger source read now; the revision still decides, so push and poll cannot both fire. (#787 item 1; ADR-worthy — see §17)
- **The Trigger source seam.** One module per source: tracker, source control, Granola, Slack, clock. Interface: its catalog entries, and `observe(subscriptions)` → a stream of Trigger events (Work item key, revision, cause, time). A subscription is an entry, its parameter values, and its Workspaces, derived from published, switched-on Workflows; a source runs only while it has one. A source writes nothing; one admission module moves observed revisions in the Control store; a pure matcher pairs events with Workflow Triggers. The catalog comes from the modules, so it cannot list an entry nothing observes. Each source is its own supervised fiber in the daemon (ADR 0022); a failure is data in daemon status. The interface is §20.3. (#787 item 2)
- **Tracker and pull request Triggers** sit on the Issue tracker and Source control provider ports and use a modified-since read per Workspace port (GitHub `since`/`sort=updated`, Linear `updatedAt`) with a watermark cursor, a short grace window, and conditional requests. Catalog keys name the connected app first (`github.issue-has-label`, `linear.issue-has-label`); the adapter stays on the port. An entry observes only in Workspaces whose port binds that app; a Workflow over GitHub and Linear Workspaces needs one Trigger per app. (#787 items 3–4; #788 item 1)
- **Receiving instead of polling** is a transport change inside one adapter; webhooks need a public address, which is hosting, so it waits. Every receive path keeps a poll backstop. (#787 item 5)
- **No read cuts items.** Every read goes to the last page; only the number of Runs in one tick waits. Each waiting or skipped item shows in the read model. (#787 item 6)
- **One poll interval** for every polled source (the existing 60 s default). Slack is push. The clock fires at exact times. A `429` makes only that source wait as the source says, reported as data. No Trigger has its own interval. (#787)
- **Schedule.** A clock source that sleeps to the next instant and re-checks the wall clock after a wake. Typed fields (every hour at minute M; every day at HH:MM; every week on days at HH:MM) plus an IANA zone that `create` fills from the machine; instants stored in UTC. After downtime: one catch-up Run for the latest missed instant. A time that does not exist on the spring DST day fires at the next valid minute; a repeated time fires once. Work context carries the scheduled instant and the fire time. (#787)
- **Sweep.** A schedule entry with a selector: source (the tracker of the Workspaces in the selection, or this Workflow's engine-minted items), state (a label or role, or parked), and idle for at least N days. Each selected item gets one Run about that item; revision `(Workflow, tick instant)`; 50 items per tick, oldest first, the rest next tick; a new lineage root. (#787)
- **Granola.** Every person connects with the browser login (works on every plan; brings the Granola MCP Plugin, ADR 0017). A Business or Enterprise person may add an API key. Two source adapters: REST `GET /v1/notes?updated_after=` when a key exists; otherwise MCP `list_meetings` with a creation-date filter and a grace window, decoded with a schema at the edge (a decode failure is a source failure reported as data; no Run starts). Entries: "Note generated", "Note edited"; "Meeting ended" is not a signal and is not in the catalog. Local Granola files are encrypted and must not be read. ([Research: Granola and Slack as Trigger sources](https://github.com/colonylabs/cogwork/issues/779); #787)
- **Slack.** One manifest app per Slack workspace, created by the person from a Cogwork-supplied manifest (an internal app: Tier 3 reads, Socket Mode, no public URL, no Cogwork client secret). One Connection `slack/<team_id>` holds the user token and the app-level token (and the bot token the manifest creates; **no output action uses it**), and records the person's user id. Events arrive on one Socket Mode connection the daemon holds; the daemon acks each envelope and reconnects on `refresh_requested`. The user token also serves the Slack MCP Plugin: one Connection, one Plugin. Entries: "I am mentioned" (user events plus a deterministic check for the person's id; parameter `channel`, no value = every channel; the item is the message; fires at once), "Message in a channel" (ambient; the item is the conversation; revision = newest `ts`; parameters channel, author (me or anyone), `quiet for` default 5 min, `at most every` default 30 min), "Reaction added" (emoji by name). **Backstop:** on each socket connect and daemon start, read what was missed since the last `ts` (`search.messages` for mentions, `conversations.history` for subscribed channels) within the catch-up window. **A message Cogwork posted does not move the revision of the conversation it was posted in**, recognized through its origin record (the posted `ts`), so Cogwork cannot wake its own ambient Trigger. "Cogwork mentioned or messaged" is not in the catalog: the Cogwork Bot is a feature of the out-of-scope chat surface. (#779; #787; #788 item 15; #790 items 10–11)
- **Timing has three layers:** the engine waits by the author's values; the agent judges readiness from the Operation's instruction and the list of what this conversation already caused, and "not yet" routes to Stop; a decisions tier may sit in front of the agent later (out of scope). (#787)
- **Parameters, not a filter language.** Each parameter has an id, a type, one value, a default, limits, and fixed choices or a named live list; one that takes many values declares `many` and the author repeats its id. No parameter means any; parameters on one Trigger are AND; Triggers on one Workflow are OR. Only the author sets a parameter; where the agent must choose, the author writes a question. (#787; #788 item 3)
- **Each entry is a condition or an occurrence**, and its name says which ("Issue has label", "New comment from a person"). A condition fires for every matching item, including items that match at switch-on; its revision is the moment it became true. An occurrence fires only after switch-on; events while off are skipped; each occurrence entry takes `catch up at most` (default 7 days, limits 0–30 days); after downtime a source goes back to the latest of the last item seen, the switch-on time, or now minus the window. (#787)
- **`connectorOnly` goes.** Each entry `requires` a Workspace port, a Connection system, or nothing; the catalog hides nothing. *Where:* a Workspace-bound entry observes only in selection Workspaces that bind the port; the read model shows "observes in 3 of 5 Workspaces". *Whether:* a Connection that is not ready stops its source; the read model shows why; no Run starts and no attempt fails. (#787)
- **Cause comes from the origin record, not the actor identity.** Cogwork writes on GitHub as the person's account, so an actor check would also exclude the person's own comments. A write is Cogwork's when it carries Cogwork's write-key marker or origin record. This applies to "New comment from a person", "New review comment from a person", and the cause of every revision. Clock and sweep start a new root; an unknown cause starts a new root. (#787; #790 item 12)
- **A late Trigger may find less than it expects** (a transcript auto-deleted, a message deleted). *Settled here, from #779 flag 7:* the Work context read is a derived need of the Run; when the source no longer has the item, the Run Plan is rejected with the reason recorded and the event shows as skipped. No attempt fails. ([Grill: Operation kind and Work context](https://github.com/colonylabs/cogwork/issues/785))
- **The catalog entry** a client reads: `key`, `name`, `description`, `kind`, `requires`, `yields` (item kind), `parameters`, plus `availability` on this machine (available, Connection needed, or unavailable for this Connection with a reason). `connections_system` widens to `granola` and `slack`; a Connection may hold more than one secret. (#787)

### 8. Operations

- **There is no Operation kind.** Every Operation is a Run with a Run Plan, a Session, Tools, and a structured result. Any registered Harness runs any Operation; the owned runner must be able to run every Operation, so none depends on an external CLI (engine ADR 0006). The one thing that varies is the **permission profile** (`read-only` default | `full`), and the engine derives the checkout from it: no Workspace → an empty scratch directory; `read-only` → the Workspace's own checkout; `full` → a branch worktree derived from the item, or the pull request's head branch when the item is a pull request. A `full` Run in the person's shared checkout cannot be expressed. (#785)
- **The owned runner's sandbox is the local-process sandbox, accepted.** The owned runner runs in the daemon on the TanStack local-process sandbox — no process isolation; confinement comes from the owned-tool policy (path confinement, symlink checks, the permission profile deciding what may be written) — as Cursor already does in the daemon today. Registering it adds a Harness to an exposure that exists, not a new kind of exposure. A stronger isolation provider is a later ticket, not a precondition of any ticket on this spec. (Maintainer's decision, 2026-10-28, on #809.)
- **Work context is one frozen shape per item kind**, read once at admission (ADR 0030, generalized to every source), plus which Trigger fired and when, and the artifacts this lineage already created. Issue: body, comments, coordination facts. Pull request: title, description, review comments, checks, review state, mergeability, head and base, changed files with line counts, the linked issue's prose — **never the diff**. Transcript: title, attendees, calendar event, summary, the full transcript. Slack: the message or conversation, its full thread, resolved names, channel name, permalink. Schedule tick: the scheduled instant and fire time, no item prose. No per-source options; if size bites, the fix is a loading mechanism, never a setting. Resource references (ADR 0032) derive from all frozen prose. After a hand-off, the next Operation re-reads the item at its own admission and receives the previous Operation's frozen result (its answers and inputs). (#785)
- **Required needs, never an allowlist.** The Tools placeholder becomes "Requires". The engine derives needs the author never writes: the source's Connection, each action's Connection, each resource reference's reader, Harness readiness. A user-authored Operation may add concrete identities (an MCP server, a Skill, a Subagent, a Command, a Hook, a Connection) with no binding row and no levels. An unready need is a Run Plan rejection, never a failed attempt. Known limit: a Workflow over every Workspace cannot name one tracker MCP server where Workspaces use different trackers. (#785)
- **Instruction ladder.** The engine composes the Operating Instructions layer — a short fixed framing (the brief is in Work context; answer through the structured result; the engine performs the outputs), then the package entry point if any, then the inline instruction, then the questions with their choices and each input's hint. It is last and highest, above every Rule. No engine guarantee rests on ladder position. (#785; #786; #789 item 11)
- **Engine-owned Tools an Operation gets by what it does:** a read-only **issue search Tool** over the selected Workspaces' trackers when a Transition creates or comments on an issue; a read-only **pull request Tool** (description, diff, changed files, comments) when a Transition acts on a named pull request. The author writes nothing to get either. (#788 item 5; #790 item 16)
- **Disposition change.** "Utility calls skip the harness" narrows to direct model calls the app makes for itself (ranking, drafting, summaries) and stops covering Operations. Engine ADR 0006 gets an amendment note when the build lands. (#785)

### 9. The outcome contract

- **A pure function in `@cogwork/contracts` derives each result schema from the published Operation**, beside Transition matching. One flat object, no unions, no optional fields, one shape per element: `{ summary, answers, inputs, workspace? }` where `answers` holds one required enum of choice ids per question, `inputs` holds the agent inputs, and `workspace` is present only when an action on a Transition needs one (values: the selection plus `none`). A `once` Operation returns one element at the top level plus `stuck`; a `for each` Operation returns `{ summary, stuck, elements }`. After decode the engine converts both to a list of elements. The existing path carries it: the JSON Schema rides in the Run Plan, TanStack `chat()` takes it as `outputSchema`, the external Harness runtime gets the same, and the executor decodes the one `structured-output.complete` object. (#786 item 1)

```json
{ "summary": "Three commitments; one duplicates an open issue.", "stuck": false,
  "elements": [ { "summary": "Taylor will add retry to the Slack sensor.",
                  "answers": { "match": "new" },
                  "inputs": { "issue_title": "Add retry to the Slack sensor", "issue_body": "…" },
                  "workspace": "cogwork" } ] }
```

- **Agent inputs are required strings, or a list with one engine-defined shape.** A string is empty when the element's matched Transitions do not use it; at decode the engine refuses an element whose matched Transitions need an input that is empty after trim, and ignores inputs no matched Transition uses. The one list shape is a review line comment `{ path, line, body }` on the new side of the diff (`review_comments`); decode checks each file is in the pull request's changed files and each line is in the diff. Reason: Anthropic's strict-schema limit of 16 union-typed parameters per request, and TanStack 1.0 turning each optional into a required nullable. (#786 item 2; #790 item 15)
- **Every Operation can report `stuck`.** The engine adds the required boolean to every derived schema. When true, the engine ignores the elements, records a non-retryable failure with `summary` as the reason, and parks the item for a person. (#786 item 5)
- **A decode failure (including over the 50-element cap) is a retryable failed attempt**; the retry's prompt carries the exact decode issues as data. No repair turn inside the Run. (#786 items 4, 6)
- **The failure Transition belongs to the engine; authors cannot route on it yet.** Run failure or timeout → retry while retryable → exhaustion → park with the reason → a handback clears it. An authored `onFailure` can come later as an additive field. Exhaustion adds no label; the engine posts its comment on the issue and parks as `exhausted`. (#786 item 7; #789 item 17)
- **An unhandled combination cannot occur at run time.** Decode makes each answer a declared choice, a published revision cannot change, and `uncovered-outcome` blocks publish. "Stop" is how an author says "do nothing". When several Transitions match one element, their actions join and the write key removes duplicates. (#786 item 8)
- **Retry and exhaustion are engine policy keyed by `(Workflow id, Operation id)`**: retryability from the existing policy, three consecutive failures per Operation per item, counted after the newest handback, at engine ADR 0011's composition point, for both coordination adapters. The author sets no retry count. (#786 item 9)

### 10. Output actions and the action plan

- **The catalog is keyed by connected app first** (`github.create-issue`, `linear.create-issue`), as Cursor Automations shows it. Shared entries repeat under each app; app-only entries sit below an "*App* only" section. Each port adapter declares the entries it supports. An entry acts only in Workspaces whose port binds that app; for a Granola or Slack element the engine limits the agent's Workspace choices to those the plan's actions can act in; a step whose app the element's Workspace does not bind shows in the plan as *skipped, and why*. (#788 item 1)
- **Each entry has one fixed target**; a different target is a different entry: this item; a new artifact in the element's Workspace; an existing issue or pull request the agent names (`issue`, `pull_request`, checked at decode against the selected Workspaces); a channel the author sets; the person. An action entry declares `key`, `name`, `description`, `requires`, target, item kinds, `needsWorkspace`, `needsFull`, `parameters`, `agentInputs`. (#788 item 2; #790 item 13)
- **Contents.**
  - **GitHub.** Shared with Linear: Create an issue (`issue_title`, `issue_body`; labels, `many`), Comment on this item (`comment`), Comment on an existing issue (`issue`, `comment`), Add a label, Remove a label, Close this issue. GitHub only: Open a pull request (`full`, Workspace; `pr_title`, `pr_body`), Push to this pull request (`full`), Comment on this pull request, Comment on a named pull request (`pull_request`, `comment_body`), Request a review (reviewer, live list), Post a review (parameter `event: approve | comment | request-changes`; `pull_request`, `review_body`, `review_comments`), Draft a review (a GitHub pending review only the person sees and submits).
  - **Linear.** The shared entries. Linear only: Move to status (live list).
  - **Slack.** Send a message (channel), Reply in thread, Add a reaction (emoji parameter), Draft a reply in Slack (the person's drafts through the Slack MCP server; the person sends it).
  - **Cogwork.** Notify me, Wait for my approval, Withdraw the pending approval, Hand to me, Stop.
  - **Absent:** merge a pull request, delete anything — because nobody asked yet, not because a rule bans them. (#788 item 4; #789 items 5, 13; #790 items 10, 13, 17)
- **Every output action acts through the person's Connection for its app.** A Workflow has no identity choice. The "as Cogwork" Slack entries do not exist. (#790 item 10)
- **Reconcile is the author's question**, not a contract on "Create an issue": `match: new | duplicate | related`, with `duplicate` and `related` routed to "Comment on an existing issue". The Granola → Issue template is the example. (#788 item 5)
- **"Open a pull request" owns the gate, and the engine pushes.** The agent commits; the action pushes the worktree branch and opens the pull request. "Push to this pull request" does nothing with no new commits. The gate is the action's precondition, checked when the engine builds the plan: the head must be ahead of the base. A failed precondition is a retryable failed attempt with reason `declined`, and the retry prompt carries the reason. A push or open that fails after the plan is frozen is a write failure. Mechanism: an invalid `pushurl` on the worktree only; the engine pushes to an explicit URL; the owned runner drops `git.push`. Known limit: this stops the normal path, not an agent that pushes to an explicit URL on purpose. (#789 item 5)
- **Every element's matched Transitions become a frozen, typed action plan at decode** — entry, parameters, inputs, target, write key — recorded before any write, in the Control store beside the item's coordination (keyed by item, Workflow, attempt), deleted when complete or withdrawn, copied into the Run ledger. Order: approval (holds the rest), writes in document order, Notify, then hand-off or Stop. **A failed write never runs the agent again:** retryable → the next tick tries the rest; permanent or three in a row → park with `write-failed`; a handback runs the rest of the plan, and write keys make completed steps do nothing. One plan executor serves the normal path, approval, "Choose an answer", and recovery. A review plan names the commit the agent reviewed; new commits withdraw it and admit the item again. (#788 items 6–7; #790 item 15; ADR-worthy — see §17)
- **Write keys.** GitHub and Linear: a hidden marker in the body through the existing marker codecs, confirmed by read-back (as the performance filer does). Slack posts: message metadata. Slack drafts: no key; a channel holds one draft, and a retry that finds one parks with that reason. The marker or origin record is how Cogwork recognizes its own writes on every source; the account never decides. (#788 item 8; #790 item 12)
- **No rate limit on visible posts.** Trigger timing, one plan per element, write keys, and the hop cap bound the growth. A Slack `429` is a retryable write failure. (#788 item 15)
- **The Issue tracker port gains create issue, comment on an existing issue, add/remove label, and close**; the Source control port gains push, request review, post review, draft review, and comment on a named pull request; a Slack write port is new. (Code facts in #788)

### 11. Human touchpoints

- **Notify me** has no agent input and does not park. It records the element's `summary` (the author may hint `summary`), the item link, the matched answers, and links to the artifacts the plan created, in the disposable Run ledger, shown on the Board until dismissed. (#788 item 9)
- **Wait for my approval.** If any matched Transition has it, the element's whole plan waits and the item parks with `awaiting-approval` (not a failure; no counters). Responses: **Approve** (names the plan digest; the plan runs verbatim), **edit then approve** (agent-input text only, decoded again with the same rules), **Reject** (as Stop; an optional note is recorded), **Hand back** with a note (the Operation runs again and makes a new plan). (#788 item 10)
- **The engine computes every plan digest.** *Settled here, from the attention prototype's open question.* The Approve command carries the digest of the plan the person saw plus any edits; the engine refuses when that digest is not current, rebuilds the plan from the edits, decodes with the same rules (returning diagnostics and running nothing on failure), and records the approval against the digest of the plan that runs. A client-side digest is display only and never binds an approval. Reason: "Approval names what it approves", and the daemon's answer is final.
- **Hand to me** parks the item with `handed-to-you`; not a failure; no counter. **Choose an answer** on that park: the person chooses the parked element's answers and writes any empty input the matched Transitions need; the engine builds and runs the plan through the one plan executor as if the agent had answered. It replaces the desktop "Approve" on a triage item; the button shows the answer ("Ready for agent"). (#789 items 13–14)
- **Handback resumes the Operation that parked**, found from the newest attempt record, not the start of the Workflow — except after `write-failed`, where it runs the rest of the plan. It is a barrier: the failures stay on record and counters count only what follows. The resumed Run gets the same Work context, resumes the Session when available, and receives the person's optional note in its prompt. No cap on handbacks. (#786 items 5a–5b; #788 input)
- **Staleness.** A new source revision on an item awaiting approval withdraws the plan and admits the item again to the Operation that made it. A plan that only grows old: the author writes a sweep over the Workflow's parked items that routes to "Withdraw the pending approval" or Stop. A new revision on a `stuck` or failure park does nothing by itself; the Board shows "changed since it parked". (#788 item 12)
- **No Workspace recognized.** If the element's plan has a step that needs a Workspace and the agent answered `none`, the whole element parks before any write with `no-workspace-recognized`, showing the planned steps. A handback with a note runs the Operation again. (#788 item 13)
- **Park reasons**, a tagged set: `stuck` (summary), `exhausted` (failure reason), `hop-cap`, `missing-operation`, `write-failed` (step and error), `no-workspace-recognized` (plan), `awaiting-approval` (plan, digest, the revision it was built on), `handed-to-you`. `needs-info` and `ready-for-human` are only label values in a document. The first three are failures; the rest move no counter. (#788 item 16; #789 item 13)
- **What the read model carries for each parked item:** its Workflow and published revision, its Operation, lineage root and parent, the element summary, a "changed since it parked" flag, the commands it offers, and the Work item reference the item tab needs. Notifications are a separate list. For each Workflow: skipped plan steps and skipped events, with reasons. (#788 item 16; [#795](https://github.com/colonylabs/cogwork/pull/795))
- **"Ready to merge" is a read-model view** of every open pull request with a Cogwork origin record that is not a draft, has no failing check, no conflict, and an approved review. No Workflow writes it; no model runs. Where it sits on the Attention page is a build decision. (#789 item 9)

### 12. The Attention surface

Settled in [Prototype: the attention inbox for Workflow parks and approvals](https://github.com/colonylabs/cogwork/issues/794) and landed on mock data in [#795](https://github.com/colonylabs/cogwork/pull/795).

- **One Attention page**, switched between a board and a list with Tabs (`?layout=`), three lanes: **Needs you**, **Notified**, **Skipped**. Every card opens in place (`?focus=<id>`); nothing opens a separate screen. The surface is one client of the command RPCs and holds no state of its own beyond per-item drafts (edited agent text, a note, a chosen answer) that survive a layout switch.
- **Card, closed:** reason icon, title, two lines (the reason's text when it has one, else the element summary), reason label, time, a "changed since it parked" mark, the source. **Card, open:** a lineage line ("From Weekly product sync · Granola → Issue r4 · Extract") that opens to every hop across Workflows; the frozen plan as one Trace line per step (pending, done, failed, skipped with its reason); agent text or the error under its step.
- **Approval:** a prompt under the plan — "Run N steps?", the digest, the revision it was built on, Reject, Approve; Edit and Hand back in a menu. Edit turns agent text into fields, and the digest follows the edit. **Handed to you:** one button per answer; a choice whose Transition needs empty input asks for it first. **Other parks:** Hand back with a note; `missing-operation` also links to the Workflow. **Notifications:** summary, matched answers, created artifacts, item link, Dismiss. **Skipped:** one card per Workflow.
- **OS notifications.** Every park raises one, `handed-to-you` included; a click opens `/attention?focus=<id>`. The mechanism, from [research on OS notifications](https://github.com/colonylabs/cogwork/blob/research/os-notifications/docs/research/os-notifications.md) and #788 item 9: the main-process Electron `Notification` API (`UNUserNotificationCenter` since Electron 42); the renderer decides when one is due, because it folds the Board, and sends a typed request over the Typed IPC seam; `main` shows it, keeps a reference to every live one in one module (a garbage-collected `Notification` is removed), and stays a dumb pipe for RPC. The `id` carries the item reference (≤ 64 characters; Electron 43 has no custom payload on macOS); a click shows the window and sends the route to the renderer; no Approve button on the banner. The first call into `Notification` happens when a person switches on a Workflow that can park, not at boot; a `failed` event means "not allowed or not signed" and the app points to System Settings. On launch the app reads `Notification.getHistory()` and the `ready` event's `launchInfo`. "Open at login" is opt-in. The daemon never posts an OS notification; to reach the person with no app running it opens the app through a `cogwork://` URL. One constant serves `setAppUserModelId` and the build's `appId` (`com.scribehow.cogwork`). Dev builds are ad-hoc signed and will report `failed`; fall back to the in-app list.
- **The side-panel Attention tab** reads the same park set after the cut-over; whether it folds into the page or stays as the narrow view is a build decision for the cut-over pull request.

### 13. The editor

Settled in [Prototype: Workflow authoring UI](https://github.com/colonylabs/cogwork/issues/658) and landed on mock data in [#777](https://github.com/colonylabs/cogwork/pull/777): a Workflows list whose rows open onto Triggers, Operations, and where each answer leads; an editor with a header, a Triggers section fed by a cascading, filterable catalog menu, and one card per Operation with its instruction, provider picker, and outcomes (every time ▸ actions; question ▸ each answer ▸ actions, hint, hand-off; combinations; "Unhandled"). The grills change the prototype as follows, and the wiring work applies them:

- The header's Save becomes **Publish**; the editor is a live view of the working copy (no local draft); the on/off switch is a separate command, not a field. Field text stays local while typing and sends one edit on pause or blur.
- **Routes become Transitions**; a Transition's identity is its answers (array of pairs, not a map); hints move to `{ field, text }`; catalog references become keys plus parameters; each Trigger names its start Operation and the first-Operation ordering convention goes; the list orders Operations along the hand-off path, then the unreached ones (advisory `unreachable-operation`).
- The Operation card gains the **permission profile**, **Requires** (replacing the Tools placeholder), **for each ⟨finding⟩**, **model options**, and **instruction package**.
- The catalog menu is **app-first**; the `connectorOnly` separator becomes `requires` plus `availability`; every option list comes from `listOptions`. Granola's "Meeting ended" and the Webhook group go; Slack's entries are the three in §7.
- The coding example drops the triage → implement and implement → follow-up hand-offs and adds the `ready-for-agent` and follow-up Triggers; "Notify me" gives way to "Hand to me" where the pipeline hands an item to the person.
- Diagnostics render at their node by class; `hand-off-and-trigger` reads "X will run two times".
- The Workflows page shows the templates when the person has no Workflows.

### 14. Workflow templates

- **A Workflow template is a Workflow document that Cogwork ships.** Using one is `create` with its document; the result is the person's own Workflow. The row records no template and has no "default" flag; a copy is deleted like any Workflow. **An app update never changes a copy**; a copy changes only through what it names (`instructionPackage`, catalog entries). No diff, no merge, no "template changed" notice; a later authoring agent may compare and propose edits. Nothing installs or switches on by itself. (#790 items 1–4; a convergence of n8n, Zapier, GitHub Actions templates, Power Automate, Apple Shortcuts, Cursor Automations)
- **The `templates` query** returns `{ id, name, description, document }`; the id is a stable slug; the apps a template uses derive from its catalog keys so a client can show only the ones that fit the person's Connections. The engine owns the templates beside the catalog. Each has `workspaces: Every`. (#790 items 4–5)
- **Templates name no model** (`harness`, `model`, `options` null), so the Default level fills them. Accepted cost: the "triage runs light" Operation-level row stops at the cut-over; the person sets it in their copy. (#790 item 8)
- **One template per tracker app.** Coding pipeline, Granola → Issue, and Staleness sweep ship for GitHub and for Linear (seven documents from one builder each); Slack → Review ships for GitHub. GitHub uses plain label names; Linear uses `state:*`. (#790 item 7)
- **A test creates every template and requires no Malformed and no Incomplete diagnostic.** A template lands in the pull request that adds the last catalog entry it needs. (#790 item 5)
- **The four templates:**
  - **Coding pipeline.** Operations triage, implement, follow-up, each with `instructionPackage` (`triage-agent`, `implement-agent`, `follow-up-agent`) and an empty inline instruction; no hand-offs. Triggers: "Issue has label `needs-triage`" → triage; "Issue has label `ready-for-agent`" → implement; "New comment from a person" on an issue with label `needs-info` → triage; "Pull request checks failed" (condition; head SHA + conclusion), "Pull request conflicts with its base" (condition; head + base SHA), "New review comment from a person" (occurrence; review bodies included), "New finding from a bot" (occurrence; bot parameter) → follow-up. Triage asks `role`: `ready-for-agent` → Add a label; `needs-info` and `ready-for-human` → Add a label + Hand to me; `wontfix` → Add a label + Close this issue; every answer → Comment on this item (the proposal). Implement has no questions: the empty-answers Transition runs Open a pull request; `stuck` covers self-halt. Follow-up asks `reply: yes | no`: the empty Transition runs Push to this pull request; `yes` adds Comment on this pull request. The no-progress limit and `stalled` are gone; the hop cap bounds the loop. (#789 items 1, 6; #790)
  - **Granola → Issue.** Trigger "Note generated" → Extract, `for each commitment`, question `match: new | duplicate | related`, inputs `issue_title`, `issue_body`. `new` → Create an issue with label `needs-triage` (so the coding pipeline takes it: composition through an external end product); `duplicate` and `related` → Comment on an existing issue. (#782; #788 item 5; #790)
  - **Slack → Review.** Trigger "I am mentioned" (every channel; the person sets one in the copy) → **Classify**, `ask: review-request | question | not-actionable`: `review-request` → Add a reaction (`eyes`), Reply in thread (hint: say you are reviewing it), hand off to Review; `question` → Draft a reply in Slack; `not-actionable` → Stop. **Review**, `verdict: approve | comment | request-changes | cannot-review`: `approve` and `request-changes` → Post a review with that event, Wait for my approval, Reply in thread (hint: say you reviewed it); `comment` → Post a review (`comment`), Reply in thread; `cannot-review` → Hand to me. The Review Operation gets the pull request Tool. (#790)
  - **Staleness sweep.** The sweep entry over parked items → **Judge**, `verdict: keep | retire | refresh`: `keep` → Stop; `retire` → Comment on this item, Close this issue; `refresh` → Add a label `needs-triage`. The build may refine it. (#790)

### 15. The validation cases, expressed

The map required the design to express these. Each is checked against the document in §2 and the catalog in §10.

- **Granola → Issue** — the template above. Exercises: an engine-minted item, fan-out, the `workspace` element answer, the reconcile question, the issue search Tool, composition into the coding pipeline through `needs-triage`.
- **Slack → Review** — the template above. Exercises: a push Trigger source, "I am mentioned", a hand-off whose next Operation reads a different artifact (the message → the pull request it names, through the pull request Tool and the `pull_request` input), review events as author parameters, line comments as a list input, approval holding a plan, plan withdrawal on new commits.
- **PR Merged → Verify** — not shipped as a template (a wrong "remainder" issue costs trust; `product.md`: precision over recall), but expressible: a pull request state Trigger with parameter `merged` (occurrence; revision = merge time; the item is the linked issue, found by link key) → **Verify**, `result: fulfilled | outstanding`, inputs `issue_title`, `issue_body`, `comment`: `fulfilled` → Close this issue; `outstanding` → Create an issue, Comment on this item. The deterministic-engine-step slot the map names is the future Step node in §2; what fills it is a separate effort.
- **Staleness sweep** — the template above; Feldspar's "the world moved on while parked", with the agent breaking ties and the engine doing the selection.
- **Scheduled digest** (Feldspar E) — expressible with a schedule Trigger, a `worth: publish | withhold` question, and Send a message, but not shipped: no ticket or validation case asks for it.
- **Feldspar shapes that do not fit** and are not in the design: frontmost-app triggers, screen capture as context, autonomous graph curation, the living knowledge layer. ([Research: Feldspar workflow ideas](https://github.com/colonylabs/cogwork/issues/657))

### 16. The migration path

From #789, in `/prefactor` order: a structural (S) pull request never changes output; each behaviour (B) change is its own pull request. If an S step changes any output, it moves to B. The S steps may run in parallel.

**Structural**

- **S1. Attempt records keyed by Operation, not stage.** The failure limit and the handback barrier take a `(Workflow, Operation)` key; the fixed pipeline passes `("coding", stage)`.
- **S2. The checkout from the permission profile, not the stage.** Triage `read-only`; implement `full` on the issue's branch; follow-up `full` on the pull request's head.
- **S3. One coordination interface, then the Control store adapter** (ADR 0033). Classification, the failure limit, and the handback barrier read through one interface; the tracker adapter is today's code; the Control store adapter is added and unused.
- **S4. The completion path takes the result schema and outcome table from the Operation** (engine ADR 0012), not from a switch on the stage.

**Behaviour**

- **B5. The engine pushes**, first on the fixed pipeline. Also: pass the `SessionId` as TanStack `threadId` unconditionally; pending interrupt rows from before TanStack 1.0 are dropped, not resolved, and no code detects them (TanStack 1.0 landed in [#792](https://github.com/colonylabs/cogwork/pull/792)).
- **B6. The Workflow engine, proven on Granola → Issue.** A build effort of several pull requests, engine first: the document schema, validator, edit vocabulary, and result-schema derivation in contracts; the Control store row and RPCs; the Trigger source seam with the Granola and clock sources; engine-minted items and lineage with the hop rule; the action plan executor; Create an issue and Comment on an existing issue; the issue search Tool; the Granola Connection (login + optional key) and `connections_system` widening; the owned runner registered in the daemon and able to run in a scratch directory; then the editor wired to the RPCs and the Attention page wired to the read model and the touchpoint commands; the Granola → Issue templates. Needs S3.
- **B7. The catalog entries for the coding Workflow:** the tracker and source-control Trigger sources on modified-since reads; the follow-up entries and "New comment from a person"; Push to this pull request; the label actions; Hand to me; Choose an answer; the coding templates.
- **B8. The cut-over**, one pull request that ships the coding default and deletes the fixed pipeline: the reconcile snapshot and its generation (engine ADR 0001), classification, the stages, the hand-written stage schemas, `Reclassify`, `HandBack.role`, Linear `roleLabels`, the Workflow and Operation setting levels and `bindings` and the `"coding"` hard-code, the no-progress limit and `stalled`, the `ready-for-human` label on exhaustion, the needs-human reason. The order of waiting work (§6) and the "Ready to merge" view (§11) land here. The engine glossary's older sense of *hand-off* (`handOff`, "hand-off explanation") is rewritten with the code. The cut-over happens with no Runs in flight; new code ignores old stage-keyed attempt records (at worst an item gets three fresh attempts); rollback is a revert; no switch runs both systems. **At the cut-over the coding pipeline stops until the person creates it from a template, publishes it, and switches it on.**

**After B8**, in their own pull requests: the Slack Connection, Slack Trigger source, Slack write port and entries, review entries, the pull request Tool, Draft a review, and the Slack → Review template; the sweep entry and the Staleness sweep templates.

### 17. Documents and ADRs the build changes

- **New ADRs, landing with the build:** the Trigger observation model (level-triggered on source revisions; one Trigger source seam) with B6/B7; the action plan (frozen before the first write; a failed write never reruns the agent) with B6; the cut-over with B8, which **supersedes engine ADR 0001** and **amends engine ADRs 0009, 0012, and 0013**.
- **Amendments:** [ADR 0007](../adr/0007-autonomous-with-override-triage-self-halts.md), the disposition's **Self-halt over gates**, and `product.md`'s "Pull request review stays on GitHub. The one hard human gate is review and merge" — human gates are the author's choice; "a person reviews and merges" describes the shipped coding template and how Cogwork is built, enforced by GitHub branch protection if a hard mechanism is wanted, not by Cogwork (#790 item 17). Engine ADR 0006 — an amendment note for the narrowed "Utility calls skip the harness" (#785). [ADR 0030](../adr/0030-work-context-carries-the-work-item-prose.md) — Work context generalizes to every source. `product.md`'s claim that the ingestion watermark "already exists" — it does not; declared, not reachable (#782).

### 18. Build facts to confirm before the pull request that depends on them

- Granola MCP `list_meetings` returns an updated time (B6).
- A manifest-install user token works with `mcp.slack.com`, and a manifest app with only user scopes receives the person's events through Socket Mode (Slack).
- `chat.postMessage` metadata reads back through `conversations.history` and `conversations.replies` (Slack write keys).
- A `pushurl` set for one worktree works (B5).
- GitHub pending reviews (no `event`) through the API, for "Draft a review".
- OS notifications: a cold-start click opens the item on macOS 26; a clean quit removes delivered notifications; Windows behaviour; test on a signed `build:unpack`, not the dev `Electron.app`.
- The edit round-trip latency budget (ADR 0023).

### 19. Code facts the grills found (declared is not reachable)

The daemon does not register the owned runner; only Cursor, Claude Code, and Codex run. ADR 0030's amendment (freeze the pull request's description and review comments) and ADR 0032 (resource references) are not built. There is no event stream, no inbound listener, no wall-clock scheduler, and no Granola, Slack, or watermark code. The Issue tracker port cannot create or close an issue; the Source control port writes only a comment and a pull request; the engine has no Slack write code. The desktop has a tray and no OS notifications, and its app id is set in two places with two values. The agent pushes the branch today. Cogwork ships no model choice for any Operation. Operation-settings resolution hard-codes the Workflow id `"coding"`.

### 20. Interfaces

The modules the build creates, each named by its interface (`/codebase-design`): what a caller must know — types, invariants, ordering, error modes — and nothing about what is inside. Three designs were drawn for each of the three seams that carry the most weight and compared on depth, locality, and seam placement; the result is below. A ticket builds behind one of these and tests through it. Type sketches are decision-bearing and belong here; names may change, shapes may not without a spec change.

**Common rule.** Every service below is an Effect service with a `Layer`. Its external interface is the test surface: a test provides the dependencies the interface names and asserts on what the interface returns. Internal seams (a row codec, a marker codec, a socket) are private to the module and tested, where they must be, by the module's own tests, never exposed for a caller's convenience.

#### 20.1 Workflows

Two modules: the pure functions in `@cogwork/contracts`, and one deep `Workflows` service in the engine. There is no `WorkflowStore` service; the row and its codec are an internal seam of `Workflows`. The RPC handlers are one line each.

```ts
// contracts — pure; the editor, the CLI, an agent, and the daemon run the same code
type WorkflowCatalog = {                      // content only; no machine state
  entries: CatalogEntry[]                     // key, name, description, kind, requires, yields | target, actsOn,
                                              // needsWorkspace, needsFull, parameters, agentInputs
  instructionPackages: string[]
  harnesses: { name: HarnessName; models: { id: string; options: { id: string; values: (string | boolean)[] }[] }[] }[]
}
type MachineReadiness = {                     // the daemon assembles it; a client may also fold it from events
  workspaces: { id: WorkspaceId; binds: string[] }[]
  connections: { system: string; ready: boolean; reason: string | null }[]
  harnesses: { name: HarnessName; available: boolean }[]
  defaultHarness: HarnessName | null
  readyNeeds: NeedIdentity[]
}
type Decoded<A> = { _tag: "Ok"; value: A } | { _tag: "Refused"; diagnostics: Diagnostic[] }

decodeWorkflowDocument(input: unknown): Decoded<WorkflowDocument>                        // `schema`
applyWorkflowEdits(document, edits: NonEmptyArray<WorkflowEdit>): Decoded<WorkflowDocument>
validateWorkflow(document, catalog: WorkflowCatalog): Diagnostic[]                       // Malformed, Incomplete, document-only Advisory
adviseReadiness(document, catalog, machine: MachineReadiness): Diagnostic[]              // machine Advisory only
availabilityOf(entry: CatalogEntry, machine: MachineReadiness): Availability             // available | connection-needed | unavailable(reason)
```

- `applyWorkflowEdits` applies the batch in order and judges only the final document: `[RemoveOperation, RemoveTrigger]` passes where `[RemoveOperation]` alone is `unknown-reference`. One Malformed in the result refuses the whole batch and the input is unchanged. Cascades keep a single edit well-formed: `RemoveOperation` sets hand-offs that named it to null; `RemoveQuestion` and `RemoveChoice` drop the Transitions whose answers named them. A Trigger whose `start` is removed is `unknown-reference`, so the client sends both edits in one batch.
- **The edit vocabulary is flat: one tag per field or list membership.** A node is addressed by its slug; a Transition by `{ operation, when }`. Each tag becomes one `toolDefinition` for an agent and one MCP tool later, which is why there is no `ReplaceOperation` and no patch object. A whole node enters only through `Add*`, with its identity and the fields it needs to exist.

```ts
type WorkflowEdit =
  | Rename { name } | SelectWorkspaces { workspaces }
  | AddTrigger { trigger } | RemoveTrigger { trigger } | SetTriggerEntry { trigger; entry }      // resets parameters
  | SetTriggerParameter { trigger; parameter; values: string[] }                                // [] removes; `many` repeats
  | SetTriggerStart { trigger; start }
  | AddOperation { operation } | RemoveOperation { operation } | RenameOperation { operation; name }
  | SetInstruction { operation; instruction } | SetInstructionPackage { operation; package: string | null }
  | SetPermissionProfile { operation; profile } | SetRequires { operation; requires }
  | SetModel { operation; model } | SetForEach { operation; forEach: string | null }
  | AddQuestion { operation; question } | RemoveQuestion { operation; question } | SetQuestionText { operation; question; text }
  | AddChoice { operation; question; choice } | RemoveChoice { operation; question; choice } | RenameChoice { operation; question; choice; name }
  | AddTransition { operation; when } | RemoveTransition { operation; when }
  | SetTransitionActions { operation; when; actions } | SetTransitionHandOff { operation; when; handOff }
  | SetHint { operation; field; text: string | null }
```

```ts
// engine — the one deep module behind the RPCs
interface Workflows {
  create(document):                 Effect<WorkflowRecord, WorkflowRefused | ControlStoreFailure>
  edit(id, edits):                  Effect<WorkflowRecord, WorkflowNotFound | WorkflowRefused | ControlStoreFailure>
  publish(id, revision):            Effect<WorkflowRecord, WorkflowNotFound | WorkflowPublishRefused /* stale-revision | incomplete */ | ControlStoreFailure>
  switch(id, enabled):              Effect<WorkflowSwitchResult, WorkflowNotFound | WorkflowSwitchRefused /* no-published-revision */ | ControlStoreFailure>
  delete(id):                       Effect<WorkflowId, WorkflowNotFound | ControlStoreFailure>
  list:                             Effect<{ workflows: WorkflowRecord[]; unreadable: { id; message }[] }, ControlStoreFailure>
  get(id):                          Effect<WorkflowRecord, WorkflowNotFound | WorkflowUnreadable | ControlStoreFailure>
  catalog:                          Effect<{ catalog: WorkflowCatalog; machine: MachineReadiness }>
  templates:                        Effect<WorkflowTemplate[]>
  listOptions(entry, parameter, workspaces): Effect<{ value; name; listedIn: WorkspaceId[] }[], never>   // source failures as data
}
type WorkflowRecord = { id; principal; workingCopy; workingRevision; publishedCopy; publishedRevision; enabled;
  diagnostics: Diagnostic[]      // validateWorkflow(workingCopy); deterministic for a revision
  readiness:   Diagnostic[] }    // adviseReadiness as of this read; never blocks
```

- Invariants: every command runs inside the Control store write gate, so batches apply in arrival order and `workingRevision` rises by one per applied batch; `WorkflowChanged` is published inside the gate after the commit, so event order is commit order; a refused command changes no row and emits no event; `delete` also switches off; reads take no gate. A row that does not decode appears in `list.unreadable` and makes `get` fail `WorkflowUnreadable`; the others load.
- Dependencies: the Control store (local-substitutable — the in-memory SQLite layer in tests; an internal seam, no port); `DaemonEventBus` (in-process); **catalog contributions** — a `WorkflowCatalogContribution { entries; templates }` Layer per Trigger source and per action port adapter, folded by `Workflows` (two adapters from the first source, so a real seam); **`MachineReadinessSource { current: Effect<MachineReadiness> }`** — the production adapter folds Connection readiness, the Harness readiness cache and catalogs, and the Workspace registry; the test adapter is a `Ref` (two adapters, a real seam; its type lives in contracts because the editor folds a second value from the events it already receives).
- Tests: the contracts functions as tables (every §5 code once positive, once negative; batch atomicity; cascades); `Workflows` through `DaemonRpcs` over the test store (lifecycle, event order, unreadable row, a Connection flipping in the `Ref` moves a `readiness` entry and never blocks publish).

#### 20.2 Coordination

One `Coordination` module keyed by a tagged **`WorkItemRef`**. The kind is on the ref; the module alone knows which authority backs it. No type parameters, no adapter in any caller's hands.

```ts
// contracts
type WorkItemRef =
  | Issue { workspace; id: WorkItemId }                         // tracker authority (ADR 0003)
  | PullRequest { workspace; number }                           // no linked issue → engine-minted
  | GranolaNote { connection; noteId }
  | SlackMessage { team; channel; ts } | SlackConversation { team; channel; threadTs }
  | ScheduleInstant { workflow; instantMillis }
  | FanOutChild { parent: WorkItemKey; run: RunId; position }
type WorkItemKey = string & Brand<"WorkItemKey">                 // keyOf(ref): deterministic, engine-minted
type OperationKey = { workflow: string; operation: string }     // the fixed pipeline passes ("coding", stage)
type Lineage = { root: LineageId; parent: LineageId | null; hop: number }   // required everywhere

Claim          = { by; claimedAtMillis; operation: OperationKey; lineage: Lineage }
AttemptRecord  = { operation: OperationKey; outcome: "succeeded" | "failed" | "abandoned"; atMillis; lineage: Lineage }
HandbackRecord = { by; atMillis; note: string | null }
ParkRecord     = { reason: ParkReason; atMillis }               // §11's tagged set, with its payload
SourceRevision = { observed: string; processed: string | null } // engine-minted items only; null on a tracker ref

// engine
interface CoordinationView {                                     // folded; the handback barrier already applied
  claim: Claim | null; claimedByUs: boolean
  barrierAtMillis: number                                        // newest handback; 0 when none
  park: ParkRecord | null                                        // newest park after the barrier; a Claim clears it
  revision: SourceRevision | null
  counters(key: OperationKey): { consecutiveFailures: number; exhausted: boolean; hop: number; hopCapped: boolean }
  gate(key: OperationKey): Open | Claimed { claim } | Quiet | Parked { reason }   // Claimed → Quiet → Parked → Open
}
interface Coordination {
  fold(ledger: Ledger, claimant: string): CoordinationView       // pure; the one composition point (engine ADR 0011)
  read(ref): Effect<CoordinationView, CoordinationError>
  claim(ref, { operation; lineage }): Effect<Claim, CoordinationError>                       // claim-held | refused
  release(ref, claim): Effect<void, CoordinationError>                                        // stale-claim
  recordAttempt(ref, { operation; outcome; lineage; reason? }): Effect<CoordinationView, CoordinationError>
  park(ref, reason: ParkReason): Effect<CoordinationView, CoordinationError>
  handBack(ref, { by; note? }): Effect<CoordinationView, CoordinationError>
  observe(ref, revision: string, cause: Cause): Effect<"moved" | "redelivered", CoordinationError>   // minted items; not-this-authority on a tracker ref
  markProcessed(ref, revision: string): Effect<void, CoordinationError>
}
CoordinationError = { reason: "unavailable" | "refused" | "claim-held" | "stale-claim" | "not-this-authority"; retryable: boolean; message }
```

- Invariants: records are appended, never deleted; `fold` is total and deterministic and counts only records with `atMillis` after the barrier; `hop` on a Claim is the parent's depth plus one, so `hopCapped` is a field read; a record that does not decode is dropped at read and reported once (no legacy branch); a tracker ref's `read` reflects the newest poll, not a live fetch — a performance fact callers must know; writes return the post-write view so no caller computes `priorFailures + 1`.
- Behind the seam: the dispatch on the ref's kind (the only place origin is named); the marker wire codecs, comment ledger, claim label, and status text for a tracker item; the SQL tables and write gate for an engine-minted item; the barrier and all four counters, which deletes `exhaustion.ts`, `applyHandbackBarrier`, and the crash counter's own barrier read.
- Dependencies: the tracker port (true external) through the existing comment host, with the existing mock hosts in tests; the Control store (local-substitutable, internal seam); the clock (in-process).
- Tests: `fold` as tables (replaces `exhaustion.test.ts` and the barrier tests in `observe.test.ts`); one contract suite over `read` and the writes, **run once per authority layer** with the same assertions — the second run is the caller that makes the seam real.

#### 20.3 Trigger observation

A **Trigger source is a value**, not a service; one `TriggerObservation` module owns everything else.

```ts
interface TriggerSource {
  id: "github" | "linear" | "granola" | "slack" | "clock"
  entries: ReadonlyArray<TriggerEntry>                           // key, name, description, kind, requires, yields, parameters
  availability(entry: CatalogKey): Effect<Availability>          // never fails; reasons are data
  listOptions(entry, parameter, workspace?): Effect<Option[], SourceFailure>
  observe(subscriptions: ReadonlyArray<Subscription>): Stream<TriggerEvent, SourceFailure>
}
type Subscription = { entry: CatalogKey; parameters: { id; value }[]; workspaces: WorkspaceId[];   // already narrowed to ports binding the app
                      catchUp: { since: number } | null }                                           // occurrence: max(last seen, switch-on, now − window)
type TriggerEvent = { key: WorkItemRef; revision: string /* opaque; equality */; cause: Person | Cogwork { origin } | Unknown; atMillis; entry: CatalogKey; workspace: WorkspaceId | null }
SourceFailure = { reason: "auth" | "unavailable" | "rate-limited" | "decode" | "connection-not-ready"; retryAfterMillis: number | null; message }

interface TriggerObservation {
  eligible: Effect<ReadonlyArray<Admission>>                     // level read: observed ≠ processed, no claim; §6 order
  changes:  Stream<void>                                         // a tick after each admission; the scheduler may wake on it
  health:   Effect<ReadonlyArray<SourceHealth>>                  // one row per source → DaemonStatus
  catalog:  Effect<ReadonlyArray<CatalogEntry & { availability }>>
}
type Admission = { item: WorkItemRef; trigger: { workflow: WorkflowId; triggerId: Slug }; operation: OperationId; revision: string; lineage: Lineage }
```

- Invariants a source adapter must honour: `observe` runs only while called, with a non-empty set; the observer re-invokes it with the new set on every subscription change (publish, switch, Workspace change) and interrupts the previous run — a Slack reconnect per publish is accepted; a source writes nothing and holds no durable state (`catchUp` makes it stateless across restarts); an occurrence adapter emits nothing before `catchUp.since`; a condition adapter emits every matching item on every read; events may repeat, and admission is idempotent (same key and revision is a no-op, so push and poll cannot double-fire); a `Cogwork` cause on an ambient Slack entry moves nothing; a typed `SourceFailure` ends the stream and the observer alone restarts it — `rate-limited` sleeps `retryAfterMillis` for that source only, `connection-not-ready` waits for the Connection event; a defect is logged, counted, and restarted on a schedule; interruption is not a failure.
- Behind the seam: fan-in of the source streams; one supervised fiber per source in a `FiberMap`; subscription derivation from published, switched-on Workflows; the pure matcher (parameters AND, Triggers OR); admission through `Coordination.observe` and item minting; lineage seeding from cause; the single poll interval and per-source cooldown; catalog assembly; health projection.
- Dependencies: the five sources (`TriggerSources` is a `Context.Service<ReadonlyArray<TriggerSource>>`; five production values plus a `ScriptedSource` probe with `emit`, `fail`, and `subscriptions` — a real seam); each source's port or client is injected into that source's own Layer (true external; mocked in the source's own tests); the clock (in-process; `ClockSource` runs for real under `TestClock`); the Control store through `Coordination`; `DaemonEventBus`.
- Tests: the engine suite swaps one Layer (`ScriptedSource`) and asserts over `DaemonRpcs` — a redelivered event starts no Run, a source runs only while subscribed, an unready Connection pauses one source and `health` says so; `ClockSource` is tested under `TestClock` with no script; pagination, `since`, and decode are each source module's own tests at its internal seam.

## Testing Decisions

A good test checks external behaviour through a production seam and would fail loudly if the behaviour broke ([`docs/agent-patterns/test-value.md`](../agent-patterns/test-value.md); the shipped `TEST-VALUE.md`). It never implements the outcome under assertion in a stub. After `Effect.flip`, it asserts the failure's `_tag` or `reason`.

**Two seams, and no third** (the module interfaces in §20 sit between them and are each module's own test surface; nothing is tested past them):

1. **The daemon's RPC surface, with the external ports stubbed.** A daemon composed from test layers — an in-memory Control store, stub Issue tracker and Source control ports, a stub Granola client, a stub Slack socket, a TestClock, and a scripted Harness that returns a chosen Operation result — is driven through the same `DaemonRpcs` the app and CLI use, and observed through its queries, its event stream, and the writes the stub ports recorded. This is the highest seam: it covers Trigger observation, admission, coordination, the plan executor, the touchpoint commands, and the read model in one place, and it is what "a client that has only the RPC can author every Workflow" means. Prior art: `daemon-composition.test.ts`, `engine.test.ts`, `commands.test.ts`, `read-model.test.ts`, `scheduler.test.ts`, `follow-up.test.ts`, `coordination-tracker.test.ts`, `recovery.test.ts` in `packages/engine`.
2. **The pure functions in `@cogwork/contracts`.** The validator, the edit vocabulary, Transition matching and `uncovered`, and result-schema derivation are pure, so they are tested as functions: a document in, diagnostics or a schema out. These are wire contracts the daemon and the desktop share, which the retention bar keeps. Prior art: `triage.test.ts`, `settings.test.ts`, `board.test.ts` in `packages/contracts`; `workflow-model.test.ts` and `workflow-parks.test.ts` in the desktop.

**What each pull request must show through those seams:**

- **Contracts.** Every diagnostic code in §5 has one case that produces it and one that does not. A template document produces no Malformed and no Incomplete diagnostic (one test over the `templates` query). The derived result schema for each template Operation compiles to a strict schema (no union, no optional) and decodes a well-formed result and refuses a malformed one with issues the retry can carry. An edit batch is atomic: one malformed edit refuses the whole batch and the working copy is unchanged.
- **Document lifecycle.** `create` → `edit` → `publish` → `switch`: publish refuses a stale revision; switch-on refuses with no published revision; switch-off declines the next admission and finishes the Run in flight; delete also switches off; `WorkflowChanged` carries the whole record.
- **Trigger observation.** A redelivered event starts no Run. An edit during a Run yields exactly one next Run. A condition entry picks up matching items at switch-on; an occurrence skips events while off and respects the catch-up window after downtime. A Slack message with Cogwork's origin record moves no revision. A tracker read that pages never drops an item (item 51 runs next tick). A Connection that is not ready stops its source with no failed attempt. The clock fires once for a DST-repeated time and catches up once after downtime.
- **Coordination and lineage.** Trackerless Claim, Attempt, and Handback records survive a daemon restart. The failure limit and the hop cap take the handback barrier. A fan-out child inherits the lineage; a person-caused event starts a new root; a follow-up loop on red CI parks with `hop-cap` at 25. An over-cap list is a retryable decode failure.
- **The action plan.** A plan is recorded before the first write. A failed write retries the rest without a new Run; three failures park with `write-failed`; a handback runs the rest and completed steps do nothing (write keys observed on the stub port). Approval holds every step; a new source revision withdraws the plan; edit-then-approve runs the edited text and names the engine's digest; a stale digest is refused. `no-workspace-recognized` parks before any write. "Open a pull request" refuses a head not ahead of base as `declined` and the retry prompt carries it. The engine, not the agent, pushes (the worktree's `pushurl` is invalid; the stub remote records the push).
- **Templates and migration.** Each coding template, created and published against the stub tracker, reproduces today's pipeline through the seam: `needs-triage` → triage comments and labels; `ready-for-agent` → implement opens a pull request; a failing check → follow-up pushes; a reporter's comment on `needs-info` → triage runs again. The cut-over pull request keeps the existing engine tests that encode ADR-backed invariants (claiming, recovery, idempotency, ownership gates) and retires only the tests whose subject is deleted (classification, stage schemas, `Reclassify`).
- **Desktop.** The editor and Attention page are tested at their provider seam with a scripted RPC client (the pattern #777 and #795 set with mock data): an edit sends one command and the field shows the daemon's value; Approve sends the digest the card shows. The UI is otherwise verified in the running app by a human; an autonomous Run reports it as unverified and never starts a dev server.

What is not tested: the real Granola, Slack, and GitHub APIs (the build facts in §18 are checked by hand once, and recorded), and OS notification delivery (verified on a signed build by a human).

## Out of Scope

From the map, and confirmed by the grills:

- **Workflow sharing** — export/import and repo-shipped definitions. The document is shaped so export is get-the-published-copy and import is `create`; the trust fight over repo-shipped executable behaviour is a later effort.
- **Preview-environment infrastructure.** Verify stays a validation case; the Step node slot exists; what fills it is separate.
- **Hosted multi-user.** Single-user; a Principal column and machine-local Control store, no tenancy.
- **The chat surface** — the authoring agent a person talks to, steer/queue, interactive sessions, and the **Cogwork Bot** (Cogwork posting about its own state in Slack). This spec shapes the contract it will drive. `@tanstack/ai-skills` (an authoring skill with examples) and `@tanstack/ai-mcp` (the same `toolDefinition` list projected to an external Harness) are "later"; Code Mode is never used for authoring.
- **The generic webhook Trigger** and webhook payloads as Work context; **receiving GitHub, Linear, and Granola events** instead of polling. Both need a public address: hosting.
- **A decisions tier** between typed Trigger parameters and a full Operation.
- **Per-Workflow budgets.** The global daily budget and concurrency stay engine-level.
- **A Model level** (`light` / `standard` / `deep`) in the document; waits for Harness adapters to own the mapping (ADR 0028).
- **Review line comments on removed lines**; the first shape covers the new side.
- **An authored `onFailure` Transition**; the engine's failure path is fixed and additive later.
- **A per-Operation round cap** separate from the hop cap.
- **Merge a pull request, delete anything, Monday digest, PR Merged → Verify as a template** — absent because nobody asked, not banned.
- **Agent-managed self-repair of Workflows** (Zapier's pattern) — a later Workflow, never engine behaviour.
- **Not borrowed:** TypeScript as the document, live-on-save, silent key dropping, a startup trust dialog, Feldspar's fail-soft deterministic fallback on judgement failure, a tracker issue per Trigger event, an event log as the Trigger authority.

## Further Notes

- **Build order.** S1–S4 may run in parallel. B5 first. **B6 proves the Workflow engine on Granola → Issue**, as the map named; it is the first Workflow a person can create, publish, switch on, and watch file an issue. B7 and B8 follow; Slack and the sweep after.
- **Provenance.** Each section names its ticket. The full reasoning — sources from [`docs/agents/technical-disposition.md`](../agents/technical-disposition.md), rejected options, prior art, convergences and borrows — is in the resolution comment of each ticket on [the map](https://github.com/colonylabs/cogwork/issues/656) and in the research documents on `research/feldspar-workflow-ideas`, `research/agents-author-automations`, `research/granola-slack-trigger-sources`, `research/tanstack-ai-agent-authoring`, and `research/os-notifications` (never merged). Read the ticket before you change a decision.
- **Decisions this spec made beyond the map:** the engine computes plan digests (§11); the diagnostic rename `duplicate-condition` → `duplicate-transition` (§5); a late Trigger whose item the source no longer has is a Run Plan rejection with the event shown as skipped (§7); the side-panel Attention tab and the "Ready to merge" placement are build decisions (§11–12); the fix-forward rule and the module interfaces in §20, added 2026-10-28 after the first build batch showed shallow modules and compatibility shims — machine-state advisories leave the validator, lineage carries its hop depth, the edit vocabulary is flat and field-level, and a Trigger source is a value under one observation module.
- **Open UI details for the build:** whether an approval opens every step's agent text by default; the exact copy of the Attention cards. Both are reversible and need no decision here.
- **Glossary.** [`packages/contracts/CONTEXT.md`](../../packages/contracts/CONTEXT.md) states the settled model in present tense and marks each fixed-pipeline term the cut-over replaces. Use its words: *hand-off* is a Transition passing its item on, giving it to a person is a *park*; *condition* is a Trigger entry kind; *revision* is always *source* or *published*; *parameter*, not option, for Trigger and action values; *Trigger source*, not sensor; the *Trigger and action catalog*, not bare catalog.
