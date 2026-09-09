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


## Fixed cost per batch

The fixture above is one batch, so it charges the batch path's fixed cost once. In a Run that cost is
paid per batch, and it is now two Git children rather than three: one `ls-tree -z` and one
`diff --raw -z --patch`. The third was the external-diff probe. It reads `GIT_EXTERNAL_DIFF` and
`diff.external` / `diff.*.command`, and now runs once per feed instead of once per batch. Attribute
selection still runs per batch through `check-attr`, because it depends on the paths in hand.

The probe is cached lazily, so a feed whose batches never reach the batch path never starts it.

Caveat on the caching: the environment half is genuinely invariant for a Run, but repository
configuration is not — an agent can `git config diff.external …` mid-Run, and `.git/**` is filtered
out of the watcher, so nothing invalidates the cached answer. Before the hoist the next batch picked
such a change up. This trades that for the saved child.

Per-path cost, for comparison, depends on what the path is rather than on how many paths there are:
one child for a tracked file that changed, two for a tracked file that did not, three for a new
untracked file. Batching wins from two paths upward for every class except two changed tracked files,
which ties. A single path stays on the per-path commands.

## Batch window

The window that gathers settled paths into a batch widened from 50 ms to 250 ms, matching the
per-path debounce, so that paths whose debounces expire near each other land in one batch instead of
several. `Stream.groupedWithin` runs that window as a free-running schedule rather than a timer
anchored to the first buffered path, so a settled path waits between 0 ms and 250 ms after its
debounce. Worst-case latency from a file settling to its diff shipping moves from roughly 300 ms to
roughly 500 ms.

How many paths a real batch actually holds was never measured, and it is the number every figure here
is indexed by. `cogwork_file_diff_settled_events_total`, `cogwork_file_diff_batches_total`, and
`cogwork_file_diff_git_children_total` make it observable: settled events over batches gives mean
paths per batch, and Git children over settled events gives the ticket's headline figure. The children
counter covers every Git child this feed starts, including the per-window `check-ignore`, and counts
at the point the child is requested rather than when it starts.
