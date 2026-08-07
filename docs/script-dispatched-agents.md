# Cross-provider Codex CLI agents

Codeman can surface workers launched by one provider through another provider's
CLI when the native worker can be attributed to the launching session. Claude
Code can use the durable `~/scripts/codex-dispatch.sh` wrapper or invoke
`codex exec` directly from a Bash tool.

## Data flow

1. `CodexDispatchWatcher` incrementally indexes recent Bash tool calls from both
   Claude lead transcripts and their `subagents/agent-*.jsonl` transcripts.
2. For the durable path, Claude invokes `codex-dispatch.sh <brief> <label>` and
   the script writes the worker's raw Codex JSONL stream to
   `~/scripts/codex-runs/codex-<label>.jsonl` and atomically updates
   `codex-<label>.done` with the run id, PID, status, and exit code.
3. For direct calls, the watcher recognizes `codex exec` only in an executable
   shell position and follows the matching native rollout under
   `~/.codex/sessions`. Synchronous calls, Claude's `run_in_background`, `&`,
   pipelines, command substitutions, `nohup`/`timeout`/`env`, and `sh -c` share
   this path. Heredoc bodies and inspection commands such as `rg "codex exec"`
   are deliberately excluded.
4. Native rollout metadata supplies the stable thread id, cwd, model, start
   time, messages, tool calls, usage, and completion state. The durable wrapper
   JSONL remains preferred when both streams exist.
5. A Claude scratchpad cwd directly identifies the parent lead session. For
   other worktrees, the watcher correlates rollout start time and declared `-C`
   cwd with the indexed Claude tool call. A launch from a Claude subagent still
   belongs to the lead session whose directory contains that subagent transcript.
6. The watcher normalizes both Codex event formats to the existing subagent event
   contract. `CompositeSubagentWatcher` merges them with native Claude
   subagents, so the web server and UI need no provider-specific route.

The UI uses the parent Claude session id for ownership and the Codex rollout cwd
for file-viewer scope. Opening a Codex worker therefore follows its worktree;
returning to the lead agent restores the lead workspace.

## Admission and identity

Codex output is treated as untrusted until all of these checks pass:

- A native rollout contains a valid thread id and identifies its origin as
  `codex_exec`.
- The rollout can be correlated to a Claude project/lead-session context through
  an encoded scratchpad cwd or a recent recognized launch tool call.
- Durable artifacts additionally require a `codex-<label>.jsonl` filename and a
  matching `thread.started` id.

Unrelated interactive or personal Codex sessions are not surfaced. The Codex
thread id, not the reusable label, is the stable worker identity.

Codeman does not scrape `ps` command lines for identity. They are transient,
reusable, and can contain the full prompt. An opaque custom launcher outside a
Claude scratchpad must therefore either expose `codex exec` in its Bash command
or implement the durable artifact contract; otherwise ownership cannot be
proved safely.

Do not consume `codex-live.feed` for discovery or completion. It is an
append-only human activity feed where concurrent workers can interleave and it
does not carry a stable worker identity. The per-label raw JSONL and atomic
`.done` files are the authoritative launcher artifacts.

## Dispatcher result delivery

Worker discovery only updates Codeman's UI; it does not send a result to the
Claude dispatcher. Dispatches which need a completion report injected back into
Claude should launch
`~/scripts/codex-run.sh <brief> <label>` as one background Bash command. The
wrapper waits for `codex-dispatch.sh`, preserves its exit code, and emits the
complete final response between `CODEMAN_RESULT_BEGIN/END` markers.

`codex-dispatch.sh` must run `codex exec` with stdin redirected from
`/dev/null`. Claude background Bash tasks retain an open stdin socket, and
Codex interprets non-TTY stdin as additional prompt input. Without the redirect
the process stops at `Reading additional input from stdin...` before producing
usable worker activity or a result. Native rollout discovery may identify the
stalled shell, but it remains idle and the dispatcher never completes.

Codeman's managed `PostToolUse(Bash)` rewake hook follows that Bash task's
native completion notification and includes a bounded 64 KiB marked report in
the feedback that resumes the owning agent. Do not launch a separate notifier
for this path. `codex-notify.sh` remains only for legacy split dispatches.

The per-worker `.done` state also makes `overwatch.sh codex <label>` independent
of other workers. A new launch resets only its own raw/report/state files; it
never truncates another worker's completion signal. Both normal and failed
Codex exits are preserved through the dispatch and run wrappers.

## Replay and lifecycle

On startup, recent dispatch files and native rollouts restore worker cards,
counters, completion state, and transcripts without replaying every historical
tool and message event over the browser connection. Only appended events are
broadcast live. Active workers become idle after a quiet interval and return to
active when a new event arrives.

Known Claude transcript paths and rollout cursors are polled incrementally.
Filesystem topology is rediscovered on a slower interval, and only changed
transcript tails are reparsed. This keeps ordinary two-second activity scans
small even when the history tree contains many old sessions.

## Transcript views

Opening a worker starts with a bounded tail of the latest 200 transcript entries.
Subagent SSE activity schedules an immediate refresh, with a two-second catch-up
poll while the worker remains active. Ordinary and tracked Ultracode agents both
render transcripts in independent in-page floating windows, so several workers
can remain visible together.

Transcript depth is implicit. Scrolling to the top requests an older page and
preserves the visible reading position while the scroll range grows. Scrolling
up also releases follow mode so incoming output cannot move that position.
Returning to the bottom or pressing Latest contracts the payload to the bounded
tail and resumes following. This contract applies to active and completed
workers; there is no separate Live/Full mode.

The external-tab action opens `/subagent/:agentId` in a stable named browser tab.
Repeated use focuses and reuses that tab instead of creating duplicates. The
standalone view uses the same bounded-tail controller and includes a Return to
Codeman action that focuses its opener when available.

The transcript endpoint's `format=blocks` response is the shared presentation
contract. `src/subagent-transcript-blocks.ts` converts normalized provider
entries into full Markdown messages, paired tool-call/result blocks, compacted
progress rows, and bounded diffs for Edit, Write, and unified-patch output.
`src/web/public/subagent-transcript-view.js` renders those blocks in both window
types. Edit blocks open with their changes visible by default; other tool calls
remain collapsed, with concise Bash intent in the summary. A reader's manual
open/closed state survives live refreshes. For durable Codex wrappers, path-only
`file_change` events are correlated from newest to oldest with the full patch in
the worker's native rollout before block rendering. Message Markdown goes through
the same sanitized renderer as the answer viewer. Raw entries and the legacy
`format=formatted` response remain available for API compatibility. Tool text and
diffs are bounded server-side so one large result cannot dominate a live browser
payload.

Each ordinary subagent window keeps its Activity/Transcript selector outside the
scrolling pane. The activity or teammate-terminal pane stays mounted while the
transcript is visible, so returning to Activity does not destroy terminal state.
Minimized and inactive-tab windows pause fetches; closing or rebuilding a window
disposes its timer and in-flight request.

Codeman deliberately does not kill these workers yet. The lifecycle state now
persists a wrapper PID and unique run id, but not a verifiable process-group
identity. Killing by reusable label or wrapper PID alone remains unsafe.

## Configuration

The default artifact directory is `~/scripts/codex-runs`. Set
`CODEMAN_CODEX_DISPATCH_DIRS` to a platform path-delimited list to watch other
launcher directories.

Additional providers should implement `SubagentSource` and join the composite
watcher. Keep provider parsing and ownership proof inside the source; do not add
provider branches to web routes or UI event handling.

Tests: `test/codex-cli-invocation.test.ts`,
`test/codex-dispatch-watcher.test.ts`, `test/subagent-watcher.test.ts`,
`test/hooks-config.test.ts`,
`test/subagent-transcript-blocks.test.ts`,
`test/mobile/subagent-transcript-stream.test.ts`.
