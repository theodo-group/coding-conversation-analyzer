# Spec: GitHub Copilot CLI export (`cca export --source copilot`)

Status: **implemented** in `src/sources/copilot.ts`.
Probed 2026-10-07 against: **Copilot CLI 1.0.92** (one non-interactive session,
`ff3b9423…`, 10 API calls across the main thread and one `task` subagent) and
**Copilot CLI 0.0.406** (one interactive session from February 2026,
`3d1c4d75…`, with an `explore` subagent).

Companion to `docs/opencode-export-spec.md` and `docs/cursor-export-spec.md`.
Same intent: describe the data model, then say what maps, what degrades, and
what is not there.

---

## 0. TL;DR

Copilot CLI keeps each conversation as an append-only **event log**, not a list
of messages, and keeps **token usage somewhere else entirely**: the log has
none, but from 1.0 a SQLite store records one row per API call. The adapter
reads the log, splits out subagent streams, pairs tool calls with their results,
and joins the usage rows back on. With the store present, a Copilot export gets
the same cost, context and simulation reports as Claude Code. Without it (0.0.x
sessions), it degrades the way Cursor does: cost omitted and said so.

---

## 1. Where Copilot CLI keeps its data

```
~/.copilot/
  session-state/<session-uuid>/
    workspace.yaml        cwd, git_root, branch, name / summary, timestamps
    events.jsonl          the event log — the transcript
    checkpoints/ rewind-file-snapshots/ files/   (not read)
  session-store.db        SQLite; per-call usage, turns, checkpoints (1.0.x+)
  agents/ skills/         user-level custom agents and skills
```

A session that never got past startup has only `workspace.yaml`; it is skipped.
Five of the six 0.0.x sessions on the probe machine were like that.

### 1.1 `events.jsonl`

One JSON object per line: `{type, id, parentId, timestamp, agentId?, data}`.
`parentId` chains each event to the previous one; the adapter relies on file
order instead, which is the same thing.

| `type` | Read for |
| --- | --- |
| `session.start` | `copilotVersion`, `selectedModel`, `context.{cwd,gitRoot,branch}` |
| `session.model_change` | the model in effect (`newModel`) |
| `user.message` | `content` (what was typed — `transformedContent` adds injected context); `agentMode` (0.0.x) |
| `assistant.message` | `content`, `reasoningText`, `toolRequests[]` (`toolCallId`, `name`, `arguments`), `model` (1.0.x) |
| `tool.execution_complete` | `toolCallId`, `success`, `result.content`, `result.detailedContent` (a unified diff for edits), `error.{message,code}` |
| `permission.requested` | `agentMode` (1.0.x) |
| `subagent.started` | `toolCallId` of the spawn → `agentId` of the child; the child's `model` |
| `session.shutdown` | per-model and per-agent usage totals; context breakdown (`currentTokens`, `systemTokens`, `toolDefinitionsTokens`, `conversationTokens`) |

Ignored: `system.message` (the system prompt), `hook.*`, `permission.completed`,
`assistant.turn_*`, `subagent.configured`/`completed`, `session.usage_checkpoint`
(prompt-cache bookkeeping, no per-call counts), `session.info`, `abort`.

`tool.execution_start` repeats what `assistant.message.toolRequests` already
says, so it is not read.

### 1.2 0.0.x vs 1.0.x

The core events are the same shape in both. 1.0.x adds `agentId` on every
subagent event, `subagent.*` events, `model` on each assistant message, hooks,
permission events and `session.shutdown`. 0.0.x tags subagent events only with
`data.parentToolCallId` (the spawning call's id), and states the model only in
`session.model_change`.

### 1.3 `session-store.db`

`assistant_usage_events` has one row per API call: `session_id`, `agent_id`
(null for the main thread), `parent_tool_call_id`, `model`, `input_tokens`,
`output_tokens`, `cache_read_tokens`, `cache_write_tokens`, `created_at`, plus
latency and AI-credit fields not used here. **`input_tokens` includes the cache
reads and writes**: on the probe, `23201 = 2 + 23005 + 194`.

Sessions from before the store existed have no rows. The store is opened
read-only through `sources/sqlite.ts`, like OpenCode's and Cursor's databases.

---

## 2. Selecting sessions for the current project

`workspace.yaml`'s `git_root` (falling back to `cwd`) is compared, after
`realpath`, against the project root and its extra roots (worktrees, Conductor
workspaces). `git_root` comes first so a session started in a subdirectory still
belongs to its repo. `realpath` matters on macOS, where `/tmp` is `/private/tmp`.

Filename stem: `cp` + the first 8 hex characters of the session uuid
(`…-cpff3b9423.md`), unambiguous next to Claude Code's stems.

---

## 3. Mapping

### 3.1 `NeutralSession`

| Field | Source |
| --- | --- |
| `uuid`, `sessionId` | session directory name |
| `cwd` | `session.start.context.cwd`, else `workspace.yaml` `cwd` |
| `version` | `session.start.copilotVersion` |
| `branch` | `workspace.yaml` `branch`, else `session.start.context.branch`; `branchSource: "snapshot"` |
| `title` | `workspace.yaml` `summary` (generated, 0.0.x), or `name` only when `user_named: true` — otherwise `name` is just the first prompt and the exporter's own fallback says the same |
| `modeTransitions` | `agentMode` changes; `interactive` until the first one |
| `usageAvailable` | `false` only when the store has no rows for the session |
| `contextBreakdown` | from `session.shutdown`, only when usage is unavailable |

### 3.2 Messages and blocks

- `user.message` → a user message with one `user_text` block.
- `assistant.message` → an assistant message: `thinking` (from `reasoningText`),
  `assistant_text`, then one `tool_use` per tool request. Kept even when empty,
  because it still stands for an API call with usage.
- `tool.execution_complete` → a `tool_result`. Consecutive results share one
  user message, as Claude Code's do. `error.code: "denied"` (the permission
  system refused the call) maps to `rejected`; any other failure to `error`.

### 3.3 Tool names and inputs

| Copilot | Canonical | Input keys |
| --- | --- | --- |
| `view` | `Read` | `path` → `file_path`; `view_range: [a, b]` → `offset: a`, `limit: b − a + 1` |
| `create` | `Write` | `path` → `file_path`, `file_text` → `content` |
| `edit` | `Edit` | `path` → `file_path`, `old_str` → `old_string`, `new_str` → `new_string` |
| `bash` | `Bash` | already `command` / `description` |
| `glob`, `grep` | `Glob`, `Grep` | already `pattern` / `path` |
| `task` | `Agent` | `agent_type` → `subagent_type` |
| `web_fetch` | `WebFetch` | |

Everything else (`report_intent`, `read_bash`, `sql`, MCP tools, …) keeps its
own name and is bucketed as `other`. `displayTool` is always Copilot's own name.

### 3.4 Diffs — exact

`edit` and `create` results carry the unified diff Copilot applied in
`result.detailedContent`. It becomes the tool call's `ExactDiff`, so the
dashboard's add/delete counts are exact. On the probe they match Copilot's own
`session.shutdown.codeChanges` (+25 / −1).

### 3.5 Subagents

The log is shared, so it is split into one stream per subagent. The key is
`agentId` (1.0.x), or `data.parentToolCallId` (0.0.x). The child transcript's id
is the `agentId`, or for 0.0.x the spawning call's id. The spawn's `tool_use` is
tagged with that id and, from `subagent.started`, the model the child ran on.

A 0.0.x subagent's model is left unknown: nothing in its stream states it, and
Copilot's built-in agents do not necessarily run on the parent's model.

### 3.6 Usage join

Rows and assistant messages are grouped by agent (the same key as the event
streams), then paired in a merge walk on time. A row is stamped 2–8 ms before
its message. A pair must be within 2 s, so a call that produced no message (an
abort) is skipped instead of shifting every later pairing. On the probe, all
10 rows paired, and the per-agent sums equal `session.shutdown`'s totals
exactly.

### 3.7 Models and prices

Copilot's ids are its own. An id the checked-in catalog knows is kept bare
(`claude-sonnet-5`), and so is an Anthropic id it knows with dashes
(`claude-sonnet-4.5` → `claude-sonnet-4-5`). These price and colour exactly as
in a Claude Code export. Anything else becomes `github-copilot/<id>`, and is
priced from the `github-copilot` provider in OpenCode's models.dev cache
(`sources/models-dev.ts`), embedded in the sidecar's `models`. A cache price
models.dev omits is a zero, not a derived one. Without the cache, such a model
falls through to `resolveModel`'s default.

Cost is computed at those list prices. Copilot bills in AI credits
(`total_nano_aiu`), which this report does not show.

### 3.8 Setup panel

Agents and skills from `.github/{agents,skills}` (project) and
`~/.copilot/{agents,skills}` (user), read by Claude Code's `readSetupDir`, which
is the same layout. The `.agent` suffix of `<name>.agent.md` is dropped.

---

## 4. Not handled yet

- **Compaction.** No compaction event was observed in either version, so none is
  mapped.
- **`abort`.** Not shown on the transcript.
- **Interactive-mode details** (`plan`, `autopilot`): the band reads `agentMode`
  but only `interactive` has been observed; other values get their own label
  where the dashboard knows them, and a hashed colour otherwise.
- **Session-store-only sessions.** The store also has `sessions`/`turns` tables;
  a session whose `session-state` directory was deleted is not exported.
