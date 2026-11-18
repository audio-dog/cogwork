# Workflows

Part of the [Contracts (shared kernel)](CONTEXT.md) glossary.

**Workflow**:
A person's reusable automation: one or more **Triggers**, the **Operations** they start, and the **Transitions** that route each Operation's answers, over a **Workspace selection**. The engine owns the routing; agent judgement is what separates one Operation from the next. Workflows compose through what they create — an issue, a pull request, or a comment one Workflow makes can trip another's Trigger.
Each Workflow has its own on / off, which a person sets and which is not part of its document. The daily budget and concurrency limits stay daemon-wide. The coding pipeline is a **Workflow template** like any other; no engine-authored Workflow remains.
_Avoid_: Playbook, automation (Cursor's word for the same idea), pipeline (except in the name of the coding pipeline), run

**Workflow document**:
The one schema-validated definition of a Workflow: its name, Workspace selection, Triggers, and Operations. Every author writes the same document — the editor, a Workflow template, a future agent — through the same command RPCs; the editor is one client, never the contract. It holds references — catalog keys, Workspace ids, Operation ids — never display copies, and it holds neither the Workflow's id nor its on / off, so a document can travel between people. Node ids are author-chosen and never change; a rename changes only the name.
_Avoid_: Workflow definition, Workflow config, draft (nobody keeps a private copy — see **Working copy**), spec

**Working copy**:
A Workflow's one shared, editable document. Every author changes it only through **Workflow edits**, which the daemon applies in arrival order, so no write rests on a stale base. It may be incomplete, never malformed.
_Avoid_: Draft, local copy, unsaved changes

**Workflow edit**:
One typed change to a working copy, naming its target by stable id. A whole document enters only through *create* — a new Workflow, a copy of a template, an agent's first version; every later change, from a person or an agent, is a list of edits applied as one.
_Avoid_: Save, patch, update (the whole-document save it replaced)

**Published revision**:
The revision of a working copy that a person **published**, and the only one the engine runs. Publishing names the revision the person sees and refuses when a newer edit has arrived, so an edit from anyone changes nothing that runs until a person publishes it. Each admission reads the current published revision and each Run records the one it ran; no older revision is kept.
_Avoid_: Version, release, saved Workflow, *source revision* (the source value a Trigger fires on)

**Diagnostic**:
One finding of the Workflow validator, returned as data: a stable code, a location by stable ids, a message, and a class. **Malformed** refuses the whole edit; **incomplete** blocks publish; **advisory** never blocks. Machine state — a Connection or a need that is not ready, a missing Harness — is only ever advisory, and switching a Workflow on has no diagnostic gate. One validator serves every client, and the daemon's answer is final.
_Avoid_: Error, warning, lint, validation failure (an incomplete working copy is not a failure)

**Workspace selection**:
Which Workspaces a Workflow observes and acts in: every Workspace, or a listed set, which may be empty. A field of the document, not a **Scope** — a Scope is where a setting lives, and this is what the Workflow is about. For a tracker or pull request Trigger it is where the Trigger observes; for a Granola or Slack item, which names no Workspace, it is the candidates the agent chooses from, plus *none recognized*.
_Avoid_: Scope, workspace filter, target

**Workflow template**:
A Workflow document that Cogwork ships. Using one is *create* with its document, and the result is the person's own Workflow: an app update never changes that copy, which changes only through what it names — an Operating-instructions package, a catalog entry's code. The Workflow records no template, so a copy is deleted like any other, and nothing installs or switches on by itself.
_Avoid_: Default Workflow (as a kind), preset, blueprint, built-in Workflow

**Trigger and action catalog**:
The engine-owned list of every Trigger entry and action entry a Workflow document may name, read through a query and never held as a constant in a client. Each entry is keyed by its connected app first (`github.create-issue`, `linear.issue-has-label`) and declares what it requires and its **parameters**; a Trigger entry also declares the item kind it yields, which fixes the Work context, and an action entry its target, the item kinds it acts on, and its **agent inputs**. An action that acts only on the current item of its own app names the app with the kind (`github.issue`). A client that has only the RPC can author every Workflow the editor can.
_Avoid_: Bare *catalog* (spent — see **Plugin catalog**), Plugin catalog, Model catalog, connector list, `connectorOnly` (retired — an entry *requires*, and the catalog hides nothing)
