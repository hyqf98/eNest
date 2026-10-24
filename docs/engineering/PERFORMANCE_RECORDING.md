# User-started performance recordings

The native Settings > General performance section provides **Start Recording**,
**Stop**, and **Export JSON**. This is separate from memory warnings: recording
does not enable or change persisted alert settings. It is off after every app
launch, and viewing its status does not invoke native measurement.

## Reproduce a workload

1. Start a recording and wait for at least two samples for the first CPU delta.
2. Open the plugins to compare. Leave each stage unchanged for several samples;
   API completion is not proof that the page has painted or is interactive.
3. Close the plugins, then retain several more samples to observe reclamation.
4. Stop and export. A native save dialog chooses the destination. Cancellation
   retains the stopped recording; export can be retried.

Leaving Settings does not stop the recording. Starting a new recording replaces
the preceding in-memory recording. Quitting the application clears it. Nothing
is uploaded automatically.

## Limits and overhead

- One active recording and one in-flight collection at a time.
- Five seconds between completed collections, not a high-frequency profiler.
- Ten-minute deadline, at most 121 samples and 4 MiB of serialized sample data.
  A collection already in progress can finish during stopping.
- At most 512 unique processes per sample; `processesTruncated` marks truncation.
- Memory measurement shares the existing monitor's in-flight or just-completed
  native result. Each sample records its memory timestamp and collection cost.
- Only the native shell can invoke the recording IPC. Plugins, theme surfaces,
  Quick and other windows do not receive a general performance-export capability.

## Data and interpretation

The `enest.performance.v2` JSON includes OS/architecture/runtime versions, logical
CPU count, total/free system memory, PID/start identity, memory value and metric,
Electron cumulative CPU seconds, stable-process CPU deltas, plugin generation,
logical/live/hibernated/cold tab counts, resource counts, focus and DevTools flags.

Host counters come from `PluginHost.getDiagnostics()`, not renderer presentation:

- `logicalTabs`: main-window shell Tab count, including nonresident placeholders.
- `live`: plugin runtime entries across shell, Quick and independent windows;
  one entry is not necessarily one exclusive renderer PID.
- `hibernated`: retained hibernation records across all containers.
- `coldShellTabs`: shell Tabs still in `installed` state with no runtime entry,
  hibernation record or in-flight open/close/reload/retire/transfer. This covers
  restored main-window placeholders; crashed or transitioning Tabs are not cold.
- `lazyDetached`: restored independent windows awaiting plugin instantiation;
  this is not the number of cold main-window Tabs.

These scopes differ, so the counters are not disjoint terms that can be added to
reconstruct `logicalTabs`. Opening, closing and retiring counts describe ongoing
operations, not additional resident plugins.

### Older recordings

`enest.performance.v1` used the ambiguous field `host.lazy` for **only**
`lazyDetached` and did not export a cold-shell count. For example, six restored
main-window placeholders could show `logicalTabs=6`, `live=0`, `hibernated=0`,
`lazy=0`; that does not mean six resident plugins. Do not infer a cold count by
subtracting other counters, and do not rewrite old recordings as v2. The original
27-sample UI-validation recording is preserved as v1 with this limitation.

### Memory and CPU

Memory is summed once per PID, not once per plugin owner. `footprint`, `private`,
`resident-swap` and `resident` are different metrics; RSS must not be relabelled
as footprint. Unknown measurements stay `null`. The measured total is a partial
sum when processes are unavailable or truncated; those counts remain explicit.

CPU uses `100 * delta(cumulative CPU seconds) / elapsed monotonic seconds`.
One fully occupied logical core is 100%; the whole machine can exceed 100%.
Only the same PID **and Electron creation time** across adjacent samples are
compared. New, exited, reused and non-Electron native child processes are not
silently assigned zero CPU. Coverage and churn counts accompany each sample.
The first sample is a baseline, not a CPU reading.

Main-process console and rotated `main.log` receive compact
`[performance-capture]` lines with capture ID, sample sequence, numeric totals,
coverage, tab counts and collection duration. Use ID plus sequence to correlate
these lines with the exported raw samples. Default-off recordings do not add
these periodic log lines.

No command lines, process names, page titles, URLs, environment variables,
filesystem paths, error payloads, storage values or activity reason strings are
recorded. Installed plugin IDs and their runtime generations are included;
review the file before sharing it. Export is local and user initiated.

DevTools and focus changes can materially alter a comparison. System free-memory
changes include other applications. This recording is not an FPS/paint latency
test, does not prove absence of long-term leaks, and cannot attribute whole-system
swap growth to eNest.

## Focused verification

`node --test tools/packaging/performance-capture-20261023.test.mjs` covers opt-in
and single-flight behavior, bounded recording, CPU identity matching and PID
deduplication, allowlisted export, and cancellation retention. It does not run
historical tests or touch existing user data. Native UI/save-dialog acceptance
must additionally be checked in the actual desktop app. The focused checks also
cover the v2 counter names and the production diagnostics classification of cold
shell Tabs versus live, hibernated, independent, crashed and transitioning Tabs.
