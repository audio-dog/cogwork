### 2. The Workflow document

The schema lives in `@cogwork/contracts` as an Effect Schema; the engine derives JSON Schema from it where TanStack needs one and decodes with Effect. The shape, as [Grill: the Workflow document](https://github.com/taylorfsteele/cogwork/issues/784) settled it and later grills amended it (the one decision-rich snippet this spec inlines):

```ts
WorkflowDocument {
  name: string
  workspaces: { _tag: "Every" } | { _tag: "Listed"; workspaces: WorkspaceId[] }   // the one union; Listed [] = none
  triggers: {
    id: Slug
    entry: CatalogKey                              // e.g. "github.issue-has-label"
    parameters: { id: string; value: string }[]    // canonical string form per parameter type
    filters: { entry: CatalogKey }[]               // Trigger filters, e.g. "github.issue-not-blocked"; [] when absent
    start: OperationId
  }[]
  operations: {
    id: Slug
    name: string
    instructionPackage: string | null              // a first-party Operating-instructions package
    instruction: string                            // inline Operating Instructions
    permissionProfile: "read-only" | "full"
    commands: { allow: string[]; deny: string[] }  // TanStack SandboxPolicy command patterns, on top of the profile
    connections: "github"[]                        // systems whose Connection credential the Run receives
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
- **`instructionPackage`** names a first-party Operating-instructions package (catalog data), resolved as today — Workspace override first (ADR 0019), then the engine package. Its entry point heads the Operating Instructions layer; the inline `instruction` follows. An unknown name is malformed. `empty-instruction` passes when either field has content. ([Grill: migrating triage → implement → follow-up onto Workflows](https://github.com/taylorfsteele/cogwork/issues/789), item 11)
- **A hint is keyed by result field**, not by action: GitHub and Linear "Create an issue" share `issue_title`, so one element writes one title and one hint guides it. ([Grill: the outcome contract](https://github.com/taylorfsteele/cogwork/issues/786), item 3)

