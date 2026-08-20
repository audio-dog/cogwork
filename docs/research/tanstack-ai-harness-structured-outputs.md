# TanStack AI harness structured outputs: Cogwork opportunity

Date: 2026-08-20.

## Recommendation

Adopt this capability after a coordinated TanStack upgrade. Use one engine-owned Effect Schema result contract across Cursor, Codex, and the owned provider runner. Keep `HarnessRunner`; pass the result schema into each `chat()` call; read the terminal `structured-output.complete` event; decode its `value.object` with Effect before applying domain decisions.

First target: triage. Replace prompt sentinels plus regex/default recovery with a structured result containing at least `proposal` and `role`. Then migrate implement and follow-up result sentinels. This is a meaningful cleanup and the right seam for future harnesses/providers.

Do not merge the external-harness and owned-provider implementations into one featureless abstraction. Their inner-loop ownership, approvals, resume, durability, usage, and structured-output reliability still differ.

## What changed

TanStack now supports `outputSchema` on the same `chat()` turn that runs a coding harness. Tool/reasoning/prose activity streams normally; the terminal object arrives in a `CUSTOM` event named `structured-output.complete`. The same call without `stream: true` returns a typed promise. This surface covers Claude Code, Codex, OpenCode, Grok Build, and ACP-compatible agents, including Cursor through Cogwork's existing `acpCompatible` integration. [Official harness structured-output guide](https://tanstack.com/ai/latest/docs/structured-outputs/harnesses)

Implementation differs behind that common contract:

| Adapter | Mechanism | Consequence |
| --- | --- | --- |
| Codex | Writes the JSON Schema into the sandbox, passes the path through native `--output-schema`, and translates the last Codex message into structured-output events. [source](https://github.com/TanStack/ai/blob/main/packages/ai-codex/src/adapters/text.ts#L233-L234), [source](https://github.com/TanStack/ai/blob/main/packages/ai-codex/src/adapters/text.ts#L327-L341), [test](https://github.com/TanStack/ai/blob/main/packages/ai-codex/tests/text-adapter.test.ts#L205-L250) | Strongest Cogwork harness path: native constraint on the same coding turn. |
| Claude Code | Uses native `--json-schema` on the same turn. [official guide](https://tanstack.com/ai/latest/docs/structured-outputs/harnesses#how-each-harness-applies-the-schema) | Also native. |
| ACP-compatible / Cursor | Appends the JSON Schema to the prompt, accumulates the last assistant text, parses JSON from it, then emits structured-output events. [source](https://github.com/TanStack/ai/blob/main/packages/ai-acp/src/adapters/compatible.ts#L549-L553), [source](https://github.com/TanStack/ai/blob/main/packages/ai-acp/src/adapters/compatible.ts#L568-L628), [source](https://github.com/TanStack/ai/blob/main/packages/ai-acp/src/adapters/compatible.ts#L713-L751) | Common API, weaker enforcement. Contract-test Cursor behavior and retain a safe decode/default policy. |
| OpenCode / Grok Build | Prompt-and-parse, like ACP. [official guide](https://tanstack.com/ai/latest/docs/structured-outputs/harnesses#how-each-harness-applies-the-schema) | Treat as capability-compatible, not reliability-identical. |
| Full model providers | `outputSchema` is converted to the provider's native mechanism and the non-streaming path returns a typed, validated object. [structured-output overview](https://tanstack.com/ai/latest/docs/structured-outputs/overview) | Same domain contract can serve cheap utility calls and the owned coding runner. |

Harness output is terminal rather than field-by-field: `partial` stays empty while tools run, then `final` arrives. Older turns retain their own structured-output parts. [Official harness guide](https://tanstack.com/ai/latest/docs/structured-outputs/harnesses#client-read-parts-and-final)

Important trust boundary: TanStack documents Standard Schema validation on the non-streaming promise path, but deliberately defers validation to the consumer on `stream: true`; the event object is normalized and typed, not automatically trustworthy domain data. [Official validation note](https://tanstack.com/ai/latest/docs/structured-outputs/overview#provider-support) Cogwork uses streams, so Effect decoding remains mandatory before changing labels, recording outcomes, or publishing text.

## Version gate

Cogwork's installed versions do not contain this feature:

| Package | Cogwork pin | Current release checked 2026-08-20 |
| --- | ---: | ---: |
| `@tanstack/ai` | 0.44.0 | 0.46.0 ([npm metadata](https://registry.npmjs.org/@tanstack%2Fai/latest)) |
| `@tanstack/ai-codex` | 0.3.2 | 0.4.1 ([npm metadata](https://registry.npmjs.org/@tanstack%2Fai-codex/latest)) |
| `@tanstack/ai-acp` | 0.2.6 | 0.3.1 ([npm metadata](https://registry.npmjs.org/@tanstack%2Fai-acp/latest)) |
| `@tanstack/ai-sandbox` | 0.3.2 | 0.3.4 ([npm metadata](https://registry.npmjs.org/@tanstack%2Fai-sandbox/latest)) |

The pinned Codex and ACP sources explicitly reject `structuredOutput()`. The current releases instead honor `outputSchema` inside `chatStream`; current Codex and ACP declare peer requirements on `@tanstack/ai ^0.46.0` and `@tanstack/ai-sandbox ^0.3.4`. [Codex package metadata](https://registry.npmjs.org/@tanstack%2Fai-codex/0.4.1), [ACP package metadata](https://registry.npmjs.org/@tanstack%2Fai-acp/0.3.1)

Therefore this is not a local one-package bump. Upgrade core, sandbox, Codex, ACP, persistence/framework packages as a tested set.

## Exact Cogwork cleanup

### 1. Replace outcome sentinels and regex parsing

Current custom protocol lives in [`packages/engine/src/playbook.ts`](../../packages/engine/src/playbook.ts):

- `TRIAGE-DECISION`, `IMPLEMENT-RESULT`, and follow-up sentinel footers;
- `parseLastSentinel` and stage-specific regexes;
- triage's second `Disposition` regex plus `sentinel | disposition | default` arbitration.

[`packages/engine/src/executor.ts`](../../packages/engine/src/executor.ts) then accumulates all assistant text, resolves the sentinel, warns on disagreement/missing output, and applies the resulting coordination outcome.

Replace that wire protocol with named Effect schemas, ideally a tagged `StageResult` union. A triage member should carry `proposal` and `role`; implementation/follow-up members should carry their existing result enum plus the human-facing summary/note required downstream. Keep one logical schema rather than parallel TanStack and Effect models.

The ACP fallback requires the last assistant message to be JSON. Human prose therefore belongs inside fields such as `proposal`, `summary`, or `note`, not after the JSON object. TanStack's parser fails the run when the final assistant text is not parseable JSON. [Official harness guide](https://tanstack.com/ai/latest/docs/structured-outputs/harnesses#how-each-harness-applies-the-schema)

### 2. Carry a result contract through the runner call

[`packages/engine/src/harness.ts`](../../packages/engine/src/harness.ts) currently gives `HarnessRequest` only prompt/session/model/tool inputs. Add a domain result-contract discriminator or stage-derived schema input. Prefer a serializable contract key/tag over placing executable schema objects in workspace config; the engine can resolve that key to its Effect Schema in-process.

At the TanStack boundary, convert the existing Effect Schema to both Standard Schema and Standard JSON Schema:

```ts
const outputSchema = Schema.toStandardJSONSchemaV1(
  Schema.toStandardSchemaV1(StageResult),
)
```

Effect v4 implements both adapters on the schema's `~standard` surface, preserving type inference, JSON Schema conversion, and validation without introducing a second schema library. See vendored Effect source at `.repos/effect/packages/effect/src/Schema.ts` (`toStandardSchemaV1`, `toStandardJSONSchemaV1`). TanStack accepts any Standard JSON Schema implementation and infers types through that contract. [Official schema-library contract](https://tanstack.com/ai/latest/docs/structured-outputs/overview#schema-libraries)

Pass this schema to all three `chat()` call sites:

- [`packages/cursor-acp/src/harness.ts`](../../packages/cursor-acp/src/harness.ts)
- [`packages/codex-cli/src/harness.ts`](../../packages/codex-cli/src/harness.ts)
- [`packages/engine/src/provider-runner.ts`](../../packages/engine/src/provider-runner.ts)

### 3. Decode `structured-output.complete` once

Cogwork is already well-positioned: `HarnessRunner` returns AG-UI events, [`AgUiEvent`](../../packages/contracts/src/ag-ui.ts) preserves `CUSTOM.name` and unknown `value`, and run activity persists the event. No new parallel result transport is required.

Add one engine-owned extractor for:

```text
event.type === CUSTOM
event.name === structured-output.complete
event.value.object
```

Decode `object` with `Schema.decodeUnknownEffect(StageResult)`. Add the decoded result to the executor accumulator; use it for coordination outcomes. Keep ordinary text accumulation for transcript/display and during rollout fallback only. TanStack's core tests guarantee event-sourced harness results are harvested without attempting to parse preceding prose, and that a missing completion produces `structured-output-missing-result`. [Official core test](https://github.com/TanStack/ai/blob/main/packages/ai/tests/chat-combined-event-structured-output.test.ts)

### 4. Consolidate harness provisioning separately

The new result contract is the primary opportunity. A nearby cleanup becomes easier during the same upgrade:

- Cursor already renders engine MCP skills through `createSecrets` + `mcpSkill` in its `defineWorkspace`.
- Codex manually builds `mcp_servers.*` config keys, encoded env names, and bearer env entries.

Move both to one shared engine-to-TanStack workspace projector. TanStack defines workspace skills/instructions once and projects native files/config per harness, while secret refs avoid persisting values. [Official provisioning guide](https://tanstack.com/ai/latest/docs/sandbox/provisioning) This deletes Codex-specific MCP rendering without changing the engine-owned `ResolvedMcpSkill` contract.

Retain Cursor's transport shim until a live compatibility test proves TanStack handles Cursor's vendor JSON-RPC request/notification forms. That concern is independent of structured output.

## Clean future API

Keep the public/domain seam small:

```text
HarnessRequest
  + result contract key
       |
       v
TanStack runner resolver
  adapter + middleware + session mapping + capability metadata
       |
       v
chat({ adapter, messages, outputSchema, stream: true, middleware })
       |
       v
AG-UI stream + decoded StageResult
```

External harnesses resolve to `codexText` or `acpCompatible`; full providers resolve to ordinary provider adapters. Both share prompt/message construction, output schema, event recording, result decoding, and domain outcome application. They do not share assumptions about the inner loop.

Record explicit capabilities rather than implying parity:

- structured-output mechanism: `native | prompt-parse`;
- session: `owned-transcript | opaque-handle`;
- tool ownership and approval support;
- durable replay/takeover;
- metered usage;
- provider-owned versus harness-owned loop.

Harness tools run inside the sandbox and do not support browser-round-trip approval gates or client-only tools; a missing server implementation or `needsApproval` fails fast. [Official harness limitations](https://tanstack.com/ai/latest/docs/structured-outputs/harnesses#approval-gates-and-client-tools) This prevents the common API from promising owned-provider semantics an external CLI cannot provide.

## Rollout and contract tests

1. Upgrade the TanStack package set on one branch; keep behavior unchanged.
2. Add adapter contract tests before changing executor logic:
   - Codex command contains `--output-schema` and produces exactly one completion event;
   - Cursor receives the schema instruction and produces one completion event from valid JSON;
   - invalid/missing Cursor JSON yields `RUN_ERROR` with `structured-output-parse-failed` or missing-result;
   - prose/tool events still precede the terminal object;
   - session resume still emits/accepts the opaque handle;
   - Effect decoding rejects an invalid object on the streaming path.
3. Introduce `TriageResult`; run structured result and legacy sentinel parsing side by side. Log disagreement, apply the legacy result.
4. After representative Cursor and Codex runs agree, make the decoded structured result authoritative. Keep a conservative `ready-for-human` failure policy, not silent coercion.
5. Remove triage sentinel footers/parsers/warnings. Repeat for implement and follow-up.
6. Generalize `UtilityModel.complete` with a typed structured variant using non-streaming `chat({ outputSchema })`; this path receives TanStack's validation and supports future full providers through the same Effect schema.
7. Consolidate workspace/MCP projection after the result-contract migration is stable.

## Bottom line

This feature makes TanStack's `TextAdapter` boundary finally useful as Cogwork's common **result** API, not only its common event API. The highest-value change is deleting the fragile stage-result text protocol. Upgrade first, keep `HarnessRunner`, use Effect Schema as the sole domain contract, and treat streamed completion objects as untrusted until Effect decodes them.
