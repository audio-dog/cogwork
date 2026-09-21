# Replay harness

The replay harness turns one recorded Run into a repeatable pipeline load. It does not start an agent subprocess or simulate worktree I/O.

## Record

Keep the daemon running, then export a Run before its events reach the 30-day retention limit:

```sh
pnpm --filter @cogwork/cli start -- replay export \
  --id RUN_ID \
  --output ../../packages/engine/replay/fixtures/representative-run.json
```

The export keeps every stored payload unchanged. Inspect and redact secrets or private data before sharing or committing a fixture. Commit only sanitized fixtures that represent a useful workload.

## Replay

Point the daemon host at a fixture and select the replay harness in Operation settings:

```sh
COGWORK_REPLAY_FIXTURE=../../packages/engine/replay/fixtures/representative-run.json \
  pnpm --filter @cogwork/cli start -- daemon

pnpm --filter @cogwork/cli start -- operation-settings set \
  --setting harness --value replay
pnpm --filter @cogwork/cli start -- operation-settings set \
  --setting model --value fixture
pnpm --filter @cogwork/cli start -- operation-settings set \
  --setting model-options --value '{"speed":"8x"}'
```

Available speeds are `1x`, `2x`, `4x`, `6x`, `8x`, and `unpaced`. Run 6-8 independent work items to reproduce the target concurrency. Events enter through the normal harness seam, so the recorder, Run ledger, daemon event bus, NDJSON transport, desktop IPC relay, and renderer receive the same traffic as a real Run.

Replay events are observations only. Structured outcomes in a fixture are recorded but never applied to the issue tracker or source-control provider.

## Score

Capture at least 10 warm-ups and 10 measured runs per side. Alternate base and head runs so each sample pair sees similar machine load. A report contains the warm-up timings and one sample per measured run:

```json
{
  "version": 1,
  "fixture": "representative-run.json",
  "fixtureDigest": "sha256:FIXTURE_SHA256",
  "concurrency": 8,
  "speed": "8x",
  "warmupMillis": [950, 944, 941, 940, 938, 939, 937, 936, 938, 937],
  "samples": [
    {
      "counts": {
        "eventsProcessed": 800,
        "sqliteInserts": 800,
        "ipcFrames": 800,
        "bytes": 125000,
        "eventBusDrops": 0
      },
      "elapsedMillis": 942
    }
  ]
}
```

Capture counts at their live boundaries during each measurement window: recorder events, SQLite inserts, NDJSON bytes, desktop IPC frames, and daemon event-bus drops. Do not infer transport counts by replaying settled ledger rows. Store the fixture SHA-256 digest in both reports. Keep fixture, concurrency, speed, machine, and background load fixed. Compare two reports:

```sh
pnpm --filter @cogwork/cli start -- replay compare \
  --base ../../tmp/replay/base.json \
  --head ../../tmp/replay/head.json
```

Read the count section first. `unstable` means a side changed counts between samples. `changed` means both sides were stable but differ. Treat either as a correctness or pipeline-shape change before reading timing.

Timing uses a deterministic bootstrap confidence interval over paired median ratios. `improvement` requires the full 95% interval below 0.98. `regression` requires it above 1.05. Otherwise the result is `inconclusive`; do not claim a timing change.
