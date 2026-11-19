# Customizable Workflows — spec

The product and architecture spec for Workflows: a person's reusable automations, authored as data, over Triggers, Operations, Transitions, output actions, and human touchpoints. It is the destination artifact of [Wayfinder map: Customizable Workflows](https://github.com/taylorfsteele/cogwork/issues/656), settled between 2026-09-11 and 2026-10-28, and it resolves [Write the Workflows spec](https://github.com/taylorfsteele/cogwork/issues/660). The tracker copy is [Spec: Customizable Workflows (#797)](https://github.com/taylorfsteele/cogwork/issues/797), labelled `ready-for-agent`; this file is the same spec in full. Where the two differ, this file is current.

Every decision below has a source: a closed ticket on the map, a research document on a `research/*` branch, or a merged pull request. Each section names its ticket; the ticket's resolution comment holds the full reasoning, rejected options, and prior art. **This document is the index and the handoff — the tickets and the research are the depth.** Where this spec settles a question the map left open, it says so. The vocabulary is [`packages/contracts/CONTEXT.md`](../../packages/contracts/CONTEXT.md) after [#796](https://github.com/taylorfsteele/cogwork/pull/796); where this spec and the glossary disagree, the glossary wins.

- [Problem Statement](./customizable-workflows-problem-statement.md)
- [Solution](./customizable-workflows-solution.md)
- [User Stories](./customizable-workflows-user-stories.md)
- Implementation Decisions
  - [1. Standing constraints](./customizable-workflows-standing-constraints.md)
  - [2. The Workflow document](./customizable-workflows-the-workflow-document.md)
  - [3. Storage, working copy, published revision](./customizable-workflows-storage-working-copy-published-revision.md)
  - [4. Commands, queries, events](./customizable-workflows-commands-queries-events.md)
  - [5. Validation and diagnostics](./customizable-workflows-validation-and-diagnostics.md)
  - [6. Work items, coordination, lineage](./customizable-workflows-work-items-coordination-lineage.md)
  - [7. Trigger observation](./customizable-workflows-trigger-observation.md)
  - [8. Operations](./customizable-workflows-operations.md)
  - [9. The outcome contract](./customizable-workflows-the-outcome-contract.md)
  - [10. Output actions and the action plan](./customizable-workflows-output-actions-and-the-action-plan.md)
  - [11. Human touchpoints](./customizable-workflows-human-touchpoints.md)
  - [12. The Attention surface](./customizable-workflows-the-attention-surface.md)
  - [13. The editor](./customizable-workflows-the-editor.md)
  - [14. Workflow templates](./customizable-workflows-workflow-templates.md)
  - [15. The validation cases, expressed](./customizable-workflows-the-validation-cases-expressed.md)
  - [16. The migration path](./customizable-workflows-the-migration-path.md)
  - [17. Documents and ADRs the build changes](./customizable-workflows-documents-and-adrs-the-build-changes.md)
  - [18. Build facts to confirm before the pull request that depends on them](./customizable-workflows-build-facts-to-confirm-before-the-pull-request-that-depends-on-them.md)
  - [19. Code facts the grills found (declared is not reachable)](./customizable-workflows-code-facts-the-grills-found-declared-is-not-reachable.md)
  - [20. Interfaces](./customizable-workflows-interfaces.md)
- [Testing Decisions](./customizable-workflows-testing-decisions.md)
- [Out of Scope](./customizable-workflows-out-of-scope.md)
- [Further Notes](./customizable-workflows-further-notes.md)
