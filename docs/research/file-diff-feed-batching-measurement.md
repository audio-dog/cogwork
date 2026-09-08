# File-diff feed batching measurement

Measured 2026-09-08 on the same isolated fixture used by `file-diff-feed.test.ts`. The fixture contains tracked changes, one untracked file, one deletion, one unchanged file, one capped diff, one duplicate event, and one ignored path.

| | Before | After | Change |
| --- | ---: | ---: | ---: |
| Total Git child processes per fixture | 10 | 5 | -50% |
| Diff child processes per fixture | 6 | 2 | -67% |
| Mean diff child duration | 60.47 ms | 61.01 ms | +0.9% |
| Worst diff child duration | 73.52 ms | 66.73 ms | -9.2% |

The process counts come from the deterministic test probe. Duration used 20 warm-cache repetitions of each before and after diff command: 120 before samples and 40 after samples. Both paths used the same worktree state, Git configuration, literal path handling, and 128 KiB capped-file input.

The batch path keeps Git's normal diff configuration. The feed detects environment, repository, and attribute-selected external diff helpers and uses the original per-path commands to preserve their payloads.
