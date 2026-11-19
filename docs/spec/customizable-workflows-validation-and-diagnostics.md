### 5. Validation and diagnostics

- **One validator, a pure function in `@cogwork/contracts`**: document and catalog **content** in, diagnostics out. The catalog it reads holds entries, instruction packages, and Harness model catalogs — never machine state. The daemon runs it on every create, edit, and publish, and its answer is final; the editor and the agent run the same function only to show problems earlier. **Advisory diagnostics that depend on the machine** — `connection-not-ready`, `need-not-ready`, `harness-unavailable`, `no-harness`, `workspace-not-registered`, `system-unbound`, `option-not-listed` — come from a second pure function, `adviseReadiness(document, catalog, machine)`, over a `MachineReadiness` snapshot the daemon assembles; they ride on the record as `readiness`, beside the document's `diagnostics`, and a machine change never republishes the Workflow (#783 items 8–9; §20). The document-only advisories (`unreachable-operation`, `hand-off-and-trigger`) stay in the validator.
- **A diagnostic carries a stable code, a location by stable ids, a message, and a class.** An unknown key is a diagnostic that names the key. A Connection that is not ready is never a fault in the document. (#783 item 9)
- **One rule: the working copy may be incomplete, never malformed.** Malformed refuses the whole edit batch (atomic). Incomplete blocks publish. Advisory never blocks. **Enable has no diagnostic gate**: it refuses only when no published revision exists; the switch result reports how many items match a condition Trigger now, as information. (#784 items 21–22)

| Class | Code | Meaning |
|---|---|---|
| Malformed | `schema` | Does not decode: unknown key (named), wrong type, missing field. |
| Malformed | `unknown-target` | An edit names a node that does not exist. |
| Malformed | `duplicate-id` | Two Operations, Triggers, or Questions share an id, or two Choices in one Question. |
| Malformed | `duplicate-transition` | Two Transitions of one Operation match the same answers. Renamed from `duplicate-condition`, because *condition* now names only a Trigger entry kind ([Update the contracts glossary for Workflows](https://github.com/taylorfsteele/cogwork/issues/791)). |
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
| Incomplete | `item-kind-mismatch` | A Trigger's item kind can reach an action that cannot act on that kind. An action that acts only on one app's items (`actsOn` value `<app>.<kind>`, for example `github.issue`) also counts when a Trigger of another app reaches it. A Trigger of no app, such as `schedule.sweep`, matches on the kind only. One finding per action. |
| Incomplete | `filter-not-applicable` | A Trigger names a filter of another app or item kind than its entry. |
| Advisory | `connection-not-ready`, `need-not-ready` | For a Trigger, an action, or a required need. |
| Advisory | `harness-unavailable`, `no-harness` | The named Harness is not available; or the document says null and no default row exists. |
| Advisory | `workspace-not-registered` | A listed Workspace was deregistered. |
| Advisory | `system-unbound` | No Workspace in the selection binds the entry's app (Trigger or action). |
| Advisory | `unreachable-operation` | No Trigger and no hand-off reaches the Operation. |
| Advisory | `option-not-listed` | A live parameter value the Connection does not list now. |
| Advisory | `hand-off-and-trigger` | A Transition hands off to X and its actions also fire a Trigger that starts X; X runs two times, one after the other. The engine does nothing special; clients show it. |

`needs-approval` (from #788) is deleted: every action acts as the person, so approval is the author's choice. (#790)

