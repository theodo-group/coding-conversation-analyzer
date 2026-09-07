# Spec: Cursor export (`cca export --source cursor`)

Status: **implemented** in `src/sources/cursor.ts` (cca 1.3.0).
Author: exploration pass, 2026-09-07; implementation notes added 2026-09-07.
Probed against: **Cursor 3.19** (macOS, `Cursor/User/globalStorage/state.vscdb` schema `_v: 18`),
one real agent session (`cdd5e6fe…`, 88 bubbles, model `grok-4.6`) plus its
subagent (`135269d9…`, 99 bubbles).

Companion to `docs/opencode-export-spec.md`. Same intent: describe the data
model, then say precisely what maps, what degrades, and what is simply not
there.

**§10 records where the implementation had to depart from this spec**, after the
design was checked against the live database. Read it alongside §2–§6; two of
the departures are load-bearing.

---

## 0. TL;DR

Cursor stores **more** structural detail than OpenCode — exact precomputed
diffs, per-bubble start/complete timestamps, thinking blocks with durations,
subagent linkage, git branch, session titles — but it stores **no token usage
whatsoever**. Every `tokenCount` in the database is literally
`{"inputTokens": 0, "outputTokens": 0}`.

So the transcript, the timeline, the diff panel, the tool tallies and the
subagent tree all port cleanly. **Cost and the token-economics half of the
dashboard cannot be reproduced**, and the context-growth simulator can only be
driven off character-count estimates rather than real usage.

Because of that, every Cursor artefact — the exported markdown *and* the
generated HTML — must carry an explicit disclaimer saying tokens are
unavailable and why. Suppressing the panels is not enough on its own; see
§4.1.1 for the required wording and insertion points.

There are two candidate data sources on disk. Only one of them is usable:

| Source | Content | Verdict |
| --- | --- | --- |
| `~/.cursor/projects/<slug>/agent-transcripts/*.jsonl` | role + text + tool *calls* | ❌ lossy — no timestamps, no tool results, no usage, no ids |
| `globalStorage/state.vscdb` (`composerData` + `bubbleId` + `agentKv`) | everything Cursor renders | ✅ this is the one |

---

## 1. Where Cursor keeps its data

macOS root: `~/Library/Application Support/Cursor/`
(Linux: `~/.config/Cursor/`; Windows: `%APPDATA%/Cursor/`.)

```
User/globalStorage/state.vscdb          ← SQLite, the real store (8.5 MB here)
User/globalStorage/state.vscdb-wal      ← 4.5 MB uncheckpointed; MUST be read
User/workspaceStorage/<wsId>/workspace.json  ← {"folder": "file:///…"} → cwd
AgentStores/cursor_agent_stores/<agentId>/   ← file-sync mounts, not transcripts
~/.cursor/projects/<path-slug>/agent-transcripts/  ← the lossy mirror (§1.4)
```

### 1.1 `state.vscdb` schema

Three tables:

- **`cursorDiskKV(key, value)`** — the conversation store. Key namespaces:

  | Key prefix | Count (probe) | Contents |
  | --- | --- | --- |
  | `composerData:<composerId>` | 4 | session metadata + ordered bubble headers |
  | `bubbleId:<composerId>:<bubbleId>` | 187 | one message/tool-call/thinking block |
  | `agentKv:blob:<sha256>` | 458 | content-addressed raw model-facing messages |
  | `composer.content.<sha256>` | ~30 | file snapshots referenced by edit results |
  | `checkpointId:<id>` | 4 | workspace checkpoints |
  | `ofsContent`, `codeBlockPartialInlineDiffFates` | 15 | editor internals, ignore |

- **`composerHeaders(…10 unnamed cols…)`** — the enumeration index. Positionally:
  `(composerId, workspaceId, createdAt, lastUpdatedAt, ?, ?, updatedAt, checkpointAt, ?, headJson)`.
  `headJson` is a `{"type":"head", …}` summary. **This is how `list()` enumerates
  cheaply without parsing 60 KB of `composerData`.**

- **`ItemTable(key, value)`** — UI state. Irrelevant except
  `glass.localAgentProjects.v1`.

### 1.2 The WAL is not optional

`state.vscdb-wal` was **4.5 MB against an 8.5 MB main file** while Cursor was
running. A read that ignores the WAL sees a stale, possibly empty conversation.
`node:sqlite` in read-only mode replays the WAL correctly, but it will refuse a
directory it cannot write a `-shm` to. The OpenCode adapter already solved the
same problem; reuse that approach.

### 1.3 Ordering

`composerData.fullConversationHeadersOnly` is an **ordered array** of bubble
headers. That array — not `createdAt` sorting — is the source of truth for
message order. Each entry:

```jsonc
{
  "bubbleId": "82978599-…",
  "type": 2,                       // 1 = user, 2 = assistant
  "createdAt": "2026-09-07T13:32:51.786Z",
  "startedAtMs": 1788787971786,
  "completedAtMs": 1788787974351,  // present on 51/88
  "grouping": {
    "isRenderable": true,
    "capabilityType": 30,
    "hasThinking": true,
    "thinkingDurationMs": 2564,
    "toolFormerTool": 40,
    "toolCallId": "call-…",
    "editLinesAdded": 12, "editLinesRemoved": 3,
    "shellStatus": "success", "taskStatus": "completed",
    "turnDurationMs": 118231,
    "textPreview": "…"
  }
}
```

The header already carries enough for the **timeline** without opening a single
bubble. Bubbles are only needed for text/params/results.

### 1.4 The `~/.cursor/projects/` jsonl mirror — why we don't use it

```
~/.cursor/projects/Users-marek-Documents-…-analyzer/
  agent-transcripts/<agentId>/<agentId>.jsonl
  agent-transcripts/<agentId>/subagents/<subId>.jsonl
```

Superficially Claude-Code-shaped (`{"role":…,"message":{"content":[…]}}`, plus
`{"type":"turn_ended"}` markers), and its directory slug is a *free
project→session index*. But every line is:

```json
{"role":"assistant","message":{"content":[
  {"type":"text","text":"I'll look at how …"},
  {"type":"tool_use","name":"Read","input":{"path":"…","limit":80}}]}}
```

Missing: **timestamps, tool_use ids, tool_result blocks entirely, usage, model,
thinking, status**. 23 lines represent 88 bubbles. It is a prompt-replay log,
not a transcript.

**Use it for enumeration only** (`slug → agentId`, and the `subagents/`
directory is the cheapest subagent-parent mapping), then read the real content
from `state.vscdb`. Or skip it and use `composerHeaders.workspaceId` +
`workspace.json`, which is equivalent and needs no path-slug guessing.

### 1.5 `agentKv:blob:` — the raw model messages

Content-addressed (`sha256`) Vercel-AI-SDK `CoreMessage` objects:

| Role | n | Notable |
| --- | --- | --- |
| `tool` | 127 | `tool-result` with **untruncated** `result` + `experimental_content` |
| `assistant` | 38 | `reasoning` (with signature) and `tool-call` with full `args` |
| `user` | 6 | includes the injected `<user_info>` env preamble |
| `system` | 2 | the full Cursor system prompt |
| *binary* | 285 | protobuf nodes (hash-linked file/checkpoint state) |

`providerOptions.cursor.highLevelToolCallResult` is the structured result, and
it encodes **status as a discriminated union** — `{"success": {…}}` vs
`{"rejected": {"command": …, "reason": "…"}}`. That is the one place a rejected
tool call is legible.

**These blobs carry no timestamps and no usage.** They are the place to go when
`bubbleId.toolFormerData.result` is a summary stub (§3.4) and you want the text
the model actually read. Linking blob→bubble is by `toolCallId`, which appears
in both.

---

## 2. Ingestion strategy

### Decision: read `state.vscdb` directly with `node:sqlite`, read-only

Identical reasoning to the OpenCode adapter, so the machinery is already there.
Cursor must be treated as possibly-running: open read-only, replay the WAL,
never write.

Do **not** shell out to `cursor` — there is no export CLI. Do **not** parse the
`~/.cursor/projects` jsonl as the primary source (§1.4).

### 2.1 Selecting sessions for the current project

```sql
SELECT c0 AS composerId, c1 AS workspaceId, c2 AS createdAt, c6 AS updatedAt, c9 AS head
FROM composerHeaders WHERE c1 = :workspaceId
```

`workspaceId` comes from scanning `User/workspaceStorage/*/workspace.json` for
`folder === file://<projectRoot>`. Cross-check against
`composerData.workspaceIdentifier.uri.fsPath`, which stores the absolute path
outright — cheaper and exact, at the cost of decoding one 50 KB JSON per
session.

Then filter out what isn't a real conversation:

- `composerId === "empty-state-draft"` and `isDraft: true` → skip
- `workspaceId === "empty-window"` → skip
- composers listed in some other composer's `subagentComposerIds` → these are
  **subagent transcripts**, not top-level sessions (§3.5)

`SourceSessionRef.mtime` ← `lastUpdatedAt` (ms). `prefix` ← first 8 chars of
`composerId`, matching the existing convention.

---

## 3. Field-by-field mapping

### 3.1 `NeutralSession`

| Field | Source | Notes |
| --- | --- | --- |
| `uuid` / `sessionId` | `composerId` | ✅ |
| `cwd` | `composerData.workspaceIdentifier.uri.fsPath` | ✅ exact |
| `title` | `composerData.name` (`"Code reuse refactoring"`) | ✅ real generated title |
| `version` | — | ❌ Cursor's app version is not in the record. Use `""` or read `Cursor/product.json` |
| `branch` | `composerData.trackedGitRepos[].branches[].branchName` | ✅ **recorded**, unlike OpenCode. `branchSource: "snapshot"` |
| `firstTimestamp` | headers[0].`createdAt` | ✅ ISO already |
| `lastTimestamp` | last header's `completedAtMs`/`createdAt` | ✅ |
| `source` | `"cursor"` | needs adding to the union in `sources/types.ts` |
| `model` | `composerData.modelConfig.modelName` → `"grok-4.6"` | ⚠️ **no provider prefix** — see §4.3 |
| `permissionMode` | `unifiedMode` (`"agent"`), `forceMode` (`"edit"`), `agentMode` (int) | ⚠️ semantics differ — §4.2 |

Bonus fields Cursor gives that the sidecar has nowhere to put:
`contextTokensUsed` / `contextTokenLimit` / `contextUsagePercent`, and a
`promptTokenBreakdown` with per-category estimates (system prompt 1021, tools
9883, rules 3281, skills 1940, MCP 194…). See §4.1 — this is the consolation
prize for having no usage.

### 3.2 Blocks (`bubbleId` records → `NeutralBlock`)

A bubble is exactly one of four things (confirmed by counting the probe's 88):

| Bubble shape | n | `BlockKind` |
| --- | --- | --- |
| `type: 1`, `text` set | 3 | `user_text` |
| `type: 2`, `text` set | 10 | `assistant_text` |
| `type: 2`, `thinking: {text, signature}` | 22 | `thinking` (+ `thinkingDurationMs`) |
| `type: 2`, `toolFormerData` set | 53 | `tool_use` **and** `tool_result` |

The last row is the important structural difference: **Cursor fuses call and
result into one record.** `toolFormerData` holds `params`/`rawArgs` *and*
`result`/`error` *and* `status`. The adapter must **split** each into a
`tool_use` block (ts = `startedAtMs`) and a `tool_result` block
(ts = `completedAtMs`), joined by `toolCallId` — the inverse of what the Claude
adapter does.

`toolFormerData.status` maps to `NeutralBlock.status`:
`completed → "ok"`, `error → "error"`, `cancelled`/`loading` → treat as
incomplete (the probe session was aborted mid-run, hence one `loading`).
`"rejected"` only surfaces via `highLevelToolCallResult.rejected` (§1.5).

### 3.3 Tool-name mapping

Cursor's names are versioned snake_case. `toolFormerData.tool` is a stable
numeric enum, `name` the string. Normalise onto the canonical names:

| Cursor `name` | `tool` | Canonical | Params (JSON string in `params`) |
| --- | --- | --- | --- |
| `read_file_v2` | 40 | `Read` | `targetFile` → `file_path` |
| `ripgrep_raw_search` | — | `Grep` | `pattern`, `path` |
| `glob_file_search` | — | `Glob` | `globPattern` → `pattern` |
| `edit_file_v2` | 38 | `Edit` | `relativeWorkspacePath` → `file_path` |
| `write_file` / `create_file` | — | `Write` | `path`, `contents` |
| `run_terminal_command_v2` | 15 | `Bash` | `command`, `cwd`, `commandDescription` |
| `task_v2` | 48 | `Agent` | `description`, `prompt`, `subagent_type` |

⚠️ **`params` and `result` are JSON-encoded strings, not objects.** Every access
needs a `JSON.parse` inside a try/catch. `rawArgs` is the model's literal
argument string and is `""` on client-initiated calls.

The list above is what one session exercised. MCP tools appear under their own
names and should fall through to `other`, same as the other adapters. Cursor's
own MCP servers are discoverable at
`~/.cursor/projects/<slug>/mcps/<server>/tools/*.json` if the setup panel ever
wants them.

### 3.4 Diffs — **better than either existing source** ✅

`edit_file_v2` carries `additionalData.precomputedDiff.lines`:

```json
{"type": "added",     "content": "import {", "modifiedLineNumber": 1}
{"type": "removed",   "content": "…",        "originalLineNumber":  7}
{"type": "unchanged", "content": "…",        "originalLineNumber": 8, "modifiedLineNumber": 9}
```

This is a real line-level diff with both line numbers — it maps **directly** to
`DiffEntry.hunk` (`added→add`, `removed→del`, `unchanged→ctx`) with no
reconstruction from before/after strings. Line counts come free from
`header.grouping.editLinesAdded` / `editLinesRemoved`, and whole-session totals
from `composerData.totalLinesAdded` / `totalLinesRemoved`.

`result` additionally gives `beforeContentId` / `afterContentId` pointing at
`composer.content.<sha256>` keys holding the full file snapshots, if an exact
`ExactDiff.patch` is ever wanted.

Caveat: `toolFormerData.result` for `read_file_v2` is a **summary stub**
(`{"totalLinesInFile": 114}`), not the content. `outChars` for the simulator
must therefore come from the `agentKv` blob's `tool-result` (§1.5), or be
approximated. This is the main reason to read `agentKv` at all.

### 3.5 Subagents ✅

Cleanly modelled, better than Claude Code's sidechain heuristics:

- `composerData.subagentComposerIds: ["135269d9-…"]`
- the spawning `task_v2` call's `additionalData.subagentComposerId` — so the
  spawn point on the timeline and the child transcript are linked *explicitly*
- `additionalData.terminationReason: "completed"`, and
  `supersededSubagentComposerIds` for retried spawns (skip those)
- the child is a full `composerData` + `bubbleId` set — recurse with the same
  reader

`SubagentSpawn.description`/`input` ← the `task_v2` `params.description` /
`params.prompt`. `model` ← the child composer's `modelConfig.modelName`.

`NeutralConversation.workflows` has no Cursor analog → always `[]`.

### 3.6 Setup panel ⚠️

| Kind | Project | User |
| --- | --- | --- |
| skill | `.cursor/skills/*/SKILL.md` | `~/.cursor/skills/`, `~/.cursor/skills-cursor/` (23 built-ins) |
| agent | `.cursor/agents/` | `~/.cursor/agents/` |
| command | `.cursor/commands/` | — |
| rule | `.cursor/rules/*.mdc` | — |

`SKILL.md` frontmatter is the same `name` / `description` shape Claude Code
uses, so `readSetupDir()` generalises with a directory-name parameter. Cursor
adds **rules** (`.mdc`), which has no `SetupItem.kind` — either add `"rule"` to
the union or fold rules in as `"command"`. Recommend adding it; it is one line
and rules are the thing Cursor users actually configure.

---

## 4. What does **not** work

### 4.1 Token usage and cost — **absent** 🔴 (the blocker)

Every single bubble, across both composers, all 187 records:

```json
"tokenCount": {"inputTokens": 0, "outputTokens": 0}
```

A regex sweep for `usage|inputTokens|promptTokens|totalTokens|cache_read`
across all 458 `agentKv` blobs matched **1** blob, and that was a tool result
echoing a source file. Cursor does not persist per-request usage locally —
consistent with it being a subscription product that meters server-side.

Consequences:

- `Usage {in, out, cw, cr}` is all zeros → **cost is £0.00 everywhere**
- `subagentUsageByModel` is empty
- `dominantModelOf()` cannot weight by tokens; fall back to
  `modelConfig.modelName`
- the context-growth simulator loses its input

What *is* available, and should be used instead of pretending:

- `composerData.contextTokensUsed` / `contextTokenLimit` (99102 / 256000) —
  a **final** context occupancy, not a per-turn series
- `promptTokenBreakdown.categories` — estimated tokens by category
  (system prompt / tools / rules / skills / MCP), a genuinely nice panel Cursor
  has and the other sources don't
- `bubble.contextWindowStatusAtCreation: {tokensUsed, tokenLimit,
  percentageRemaining}` — present on only **2 of 88** bubbles here, so it is a
  sparse sampling of the context curve, not a replacement series

**Recommendation:** make the dashboard's cost/token panels
*conditionally rendered*. Add an explicit `usageAvailable: false` (or
`usageSource: "none" | "recorded"`) to the sidecar rather than emitting zeros —
zeros read as "this session was free", which is a wrong claim, not a missing
one. Render the `promptTokenBreakdown` panel in that slot instead.

### 4.1.1 Required disclaimer — **markdown and HTML both** 🔴

Suppressing the cost panels is necessary but not sufficient. A silently missing
panel is indistinguishable from a panel that rendered zero, and both read as a
claim about the session. **Every Cursor artefact must state, in the artefact
itself, that token and cost figures are unavailable — and why.** A reader who
opens one exported `.md` or one `-dashboard.html` out of context must not be
able to mistake the absence for a measurement.

Canonical wording, used verbatim across the five surfaces below so the phrasing
is greppable and consistent:

> **Token counts are not available for Cursor sessions.** Cursor does not record
> per-message token usage on disk (every `tokenCount` is zero); usage is metered
> server-side. Cost, cache and token-per-turn figures are therefore omitted
> rather than estimated. Message, tool, timing and diff data are complete.

Insertion points, all gated on `source === "cursor"` so Claude Code and OpenCode
output is untouched:

**1. Markdown frontmatter** (`src/export-history.ts:422-428`) — the block that
currently emits `uuid/branch/started/ended/duration/messages/tools`. Add a
machine-readable key so downstream tooling can branch without prose-matching:

```yaml
source: cursor
tokens: unavailable
```

**2. Markdown body** — one blockquote immediately after the closing `---` of the
frontmatter, before the first `## 🧑 User` block. Prose form of the wording
above. This is the surface most likely to be read in isolation (pasted into a
PR, an issue, a doc), so it takes the full sentence, not a bare flag.

**3. Dashboard HTML** (`src/generate-dashboard.ts`) — three coordinated changes:

- `statTiles()` (`:303`, `:324`) — the `["Total cost", fmtMoney(...)]` tile must
  not render `$0.00`. Replace the value with `n/a` and attach a `title=` /
  visible footnote marker rather than dropping the tile silently; a missing
  tile in a grid reads as a layout bug, an `n/a` reads as a fact.
- `costSection()` (`:343-357`) and `costContextChart()` (`:192`) — replace the
  whole cumulative-cost/context chart with a callout carrying the disclaimer
  text, plus the `promptTokenBreakdown` panel from §4.1 where available. The
  chart's context axis is as unusable as its cost axis, since both derive from
  `TimelinePoint.usage`.
- A persistent banner at the top of the report, not only inside the cost row —
  the cost row can be scrolled past.

**4. Discussion HTML** (`src/generate-html.ts`) — the per-message context
annotations come from the `<!--cca-ctx:N-->` markers, written at
`src/export-history.ts:382` from the value computed at `:294-297`.

Good news: that computation already ends in `|| undefined`, so a zero sum
yields `undefined` and `:381` skips the marker. **Cursor therefore emits no
`cca-ctx` markers for free** — no code change needed, and no `cca-ctx:0` can be
produced. Confirm this with the test in §7 rather than assuming it, since the
behaviour is incidental rather than intended.

What *does* need doing: the viewer's context gutter/legend must not render an
empty axis when every marker is absent. Suppress it and put the disclaimer in
its place.

**5. Index HTML** (`src/generate-index.ts`) — if the index lists a cost column,
Cursor rows show `n/a`. A zero here is worse than elsewhere: it sorts as the
cheapest session in a mixed-source index.

Style note: this is a statement of provenance, not an apology or a warning.
Neutral typography — the existing callout/`row-label` styling, not red error
chrome. The data that *is* present is complete and trustworthy, and the wording
says so in its last sentence.

### 4.2 Permission-mode band — **different axis** ⚠️

Cursor has no permission modes. It has `unifiedMode` (`"agent"` / `"chat"`),
`forceMode` (`"edit"`), and per-bubble `agentMode` (int). Only 3 bubbles carried
`agentMode` at all, so transitions are barely observable.

Same call as OpenCode: emit a single segment at `t=0` labelled with
`unifiedMode`, and let the band be flat. Do not invent transitions.

Per-tool sandbox policy *is* recorded
(`params.requestedSandboxPolicy.type: "TYPE_WORKSPACE_READWRITE"`,
`networkAccess: false`) — a per-call attribute, not a session band. Out of scope
for the band; potentially interesting in the transcript.

### 4.3 Model identifiers — **no provider prefix** ⚠️

`"grok-4.6"`, not `"xai/grok-4.6"`. `NeutralSession.model` is documented as
`<provider>/<model>`, so the adapter must map. And `src/models.ts` has **no
xAI/Grok entries at all** (grepped: zero hits), nor entries for Cursor's
`composer-*` house models or its `auto` selection.

Given §4.1 makes prices moot for cost, the practical need is only for
**model colours and labels**. Add catalog entries with correct
`limit.{context,output}` (256000 context is recorded outright) and leave
`cost` populated from models.dev where known — but the export must not present
a computed cost, since the token counts multiplying those prices are zero.

`modelConfig.selectedModels[].parameters` also records
`effort: "high"`, `fast: "true"` — reasoning-effort metadata neither other
source provides. No sidecar slot; worth one.

### 4.4 Message-level `usage` on the timeline ⚠️

`TimelinePoint.usage` is documented "present on assistant API calls only".
Cursor cannot fill it. Leave it absent (not zeroed) so readers can distinguish.

### 4.5 Compaction — **not observable** ⚠️

`speculativeSummarizationEncryptionKey` and `summarizedComposers` exist in the
record, and `conversationState` is a base64 protobuf blob that likely encodes
the summarisation chain, but nothing surfaced a legible compaction event in the
probe. `BlockKind: "compaction"` will simply never be emitted. Acceptable.

### 4.6 Slash commands / skill invocations ⚠️

No `skill_prompt` / `skill_call` / `local_command` analog observed. Cursor
injects rules and skills into the system prompt rather than as visible turns —
`promptTokenBreakdown` confirms they are budgeted (rules 3281, skills 1940
tokens) but they never appear as blocks. These kinds go unused.

### 4.7 Task notifications — **no analog** ✅ (harmless)

Same as OpenCode. Subagents are synchronous; `notification` is never emitted.

### 4.8 `turn_ended` markers exist only in the lossy mirror ⚠️

The jsonl mirror has explicit `{"type":"turn_ended","status":"success"}`
records; `state.vscdb` does not. Turn boundaries must be inferred from
`type: 1` (user) bubbles, plus `header.grouping.turnDurationMs` where present
(2 of 88). Inferring from user bubbles is what the other adapters already do.

---

## 5. Concrete breakages in existing code

### 5.1 `source` union is closed 🔴

`"claude-code" | "opencode"` appears in `sources/types.ts` (×3) and
`sidecar.ts`. Add `"cursor"`. The sidecar comment "Absent means Claude Code"
stays valid.

### 5.2 Zero usage propagates as fake cost 🔴

`sumUsageByModel()` / cost rendering will emit `$0.00` with confident styling.
Needs the `usageAvailable` flag from §4.1 threaded into
`generate-dashboard.ts` and `generate-simulation.ts`, with the cost card and
the simulator either hidden or replaced by the breakdown panel.

### 5.3 `TOOL_BUCKETS` doesn't know Cursor names 🔴

Same failure as OpenCode had. `read_file_v2`, `ripgrep_raw_search`,
`edit_file_v2`, `run_terminal_command_v2`, `task_v2` all fall to `other` unless
the adapter normalises first (§3.3). The adapter is the right place — that is
the stated architecture.

### 5.4 `formatToolInput()` expects parsed objects 🟠

Cursor's `params` is a JSON *string*. The adapter must parse and re-key before
handing over, or every tool renders as a quoted blob.

### 5.5 Call/result fusion 🟠

Every other source emits `tool_use` and `tool_result` as separate events with
separate ids. Cursor emits one fused bubble. The adapter must synthesise the
pair and preserve `toolCallId` as `id`/`toolUseId` so the simulator's
apportioning still joins correctly. Note the ids contain a literal `\n`
(`"call-…-44\nfc_…_7"`) — do not assume they are single-line.

### 5.6 Context-window limit 🟡

256000 for grok-4.6 is recorded per session in `contextTokenLimit`. Prefer the
recorded value over any hard-coded default — Cursor's limits vary by model and
by "max mode".

### 5.7 Re-export detection 🟡

`findExistingExports()` keys off the filename stem. `composerId` is a UUID, so
the existing `<timestamp>-<prefix>` convention works unchanged.

---

## 6. Implementation plan

### 6.1 Shape

One new file, `src/sources/cursor.ts`, implementing `SourceAdapter`. No changes
to `export-history.ts` beyond the `source` union and the usage-availability
flag. Reuse the OpenCode adapter's read-only-SQLite-with-WAL helper — extract
it to a shared module rather than copy it, since that is now two callers.

### 6.2 Ordered work items

1. Extract the read-only SQLite/WAL open helper out of `sources/opencode.ts`.
2. Add `"cursor"` to the `source` unions; add `"rule"` to `SetupItem.kind`.
3. Add `usageAvailable` (or `usageSource`) to the sidecar; make the cost card
   and simulator conditional. **Verify Claude output stays byte-identical.**
3a. Implement the §4.1.1 disclaimer across all five surfaces (md frontmatter,
   md body, dashboard, discussion, index). Do this in the *same* change as
   item 3 — a build that suppresses cost without explaining the suppression is
   worse than one that does neither.
4. Workspace resolution: `workspaceStorage/*/workspace.json` → `workspaceId`.
5. `list()` over `composerHeaders`, filtering drafts, `empty-window`, and
   subagent composers.
6. `load()`: `composerData` → session meta; walk
   `fullConversationHeadersOnly`; fetch each `bubbleId` row; classify into the
   four block shapes (§3.2); split fused tool bubbles.
7. Tool-name/param normalisation table (§3.3).
8. `precomputedDiff` → `DiffEntry.hunk` (§3.4).
9. Subagent recursion via `subagentComposerIds`, skipping superseded ones.
10. Optional: `agentKv` join by `toolCallId` for real `outChars` and rejected
    status. Gate behind a flag — it costs a full 458-row scan.
11. `setup()` over `.cursor/` dirs (§3.6).
12. Add xAI/Grok + Cursor house models to `src/models.ts`.
13. `promptTokenBreakdown` panel in place of the cost card.

Items 1–9 give a complete transcript, timeline, and diff report. 10–13 are
polish — **except the §4.1.1 disclaimer (item 3a), which is not optional and
ships with item 3.**

### 6.3 CLI surface

`cca export <dir> --source cursor [--cursor-dir <path>]`, mirroring
`--claude-dir`. The `--cursor-dir` flag is what makes the regression rule
testable: point it at a frozen copy.

---

## 7. Test plan

- **Regression:** export a frozen `~/.claude` copy before and after every
  shared-code change; diff must be empty (`CLAUDE.md` rule).
- **Fixture:** copy `state.vscdb` + `-wal` + `-shm` from a real session into
  `test/fixtures/cursor/`. It is self-contained — no `~/.cursor` needed.
- **WAL:** verify a session written seconds ago (still in WAL, not
  checkpointed) exports fully. This is the failure mode most likely to ship.
- **Fused tools:** assert every `tool_use` has a matching `tool_result` and the
  `\n`-containing ids round-trip.
- **Subagents:** assert `135269d9…` appears as a child, not as a top-level
  session, and that `supersededSubagentComposerIds` entries are excluded.
- **Aborted sessions:** the probe session has `status: "aborted"` with a
  `loading` tool call. Assert no crash and no phantom result.
- **Disclaimer present (§4.1.1):** assert a Cursor export emits
  `tokens: unavailable` in the markdown frontmatter, the disclaimer blockquote
  in the markdown body, and the banner in the dashboard HTML. Assert the string
  `$0.00` appears **nowhere** in any Cursor artefact, and that no `cca-ctx`
  marker is written at all (this should hold without new code — see §4.1.1
  point 4 — so the test guards an incidental behaviour, which is exactly the
  kind that regresses silently).
- **Mixed-source index:** an index containing both Claude and Cursor sessions
  must show `n/a` (not `0`) for Cursor cost, and must not sort Cursor rows as
  cheapest.

---

## 8. Open questions

1. **Does usage ever appear?** Every probe was one Cursor version, one model
   (`grok-4.6`), one subscription tier. Worth re-probing with an
   API-key/BYOK configuration, where Cursor might record usage because the user
   is billed directly. If it does, the §4.1 blocker becomes conditional rather
   than absolute.
2. **`conversationState`** is a base64 protobuf on every composer and bubble.
   It plausibly holds the compaction/summarisation chain and possibly usage.
   Decoding it is a half-day of protobuf archaeology with an uncertain payoff —
   worth a timebox before accepting §4.5.
3. **The 285 binary `agentKv` blobs** are protobuf file-state nodes. Confirmed
   to contain file paths, contents, diffs and a `Europe/Paris` timezone string.
   Probably not needed, but they are where `timeZone` could come from — the
   sidecar has that field and nothing else on disk supplies it.
4. **Cloud/background agents** (`cloudAgentRepository.agents.*` in `ItemTable`,
   `source: 'cloud-cache'` in `conversation-search.db`) are a second class of
   conversation this spec does not cover.
5. **Cursor version** for `NeutralSession.version` — `Cursor/product.json` or
   the app bundle? Neither is in the conversation record, so whatever we use is
   "version at export time", not "version that produced the session".

---

## 9. Appendix: probe notes

Session `cdd5e6fe-a15d-4969-8af1-91fa7b508e46` — "Code reuse refactoring",
grok-4.6 (effort high), `unifiedMode: agent`, status `aborted`,
88 bubbles / 8m18s, 99102 of 256000 context tokens, one `task_v2` subagent.

Tool tally from `toolFormerData`: `read_file_v2` 26 (1 error),
`ripgrep_raw_search` 10, `edit_file_v2` 4 (+2 error),
`run_terminal_command_v2` 4 (+1 cancelled, +1 loading), `glob_file_search` 3,
`task_v2` 1.

Subagent `135269d9-…` — "Extract sidecar + HTML helpers", 99 bubbles,
status `completed`, `totalLinesAdded: 183`, `totalLinesRemoved: 360`,
branch `main` via `trackedGitRepos`.

Queries used are reproducible against a copy of `state.vscdb`(+`-wal`,`-shm`):

```sql
SELECT substr(key,1,instr(key||':',':')-1), count(*), sum(length(value))
FROM cursorDiskKV GROUP BY 1 ORDER BY 2 DESC;
SELECT value FROM cursorDiskKV WHERE key = 'composerData:<composerId>';
SELECT key, value FROM cursorDiskKV WHERE key LIKE 'bubbleId:<composerId>:%';
```

---

## 10. Implementation notes — where the probe was wrong

Written while implementing §6 against a live `state.vscdb`. Everything not
listed here held up exactly as specified. The two marked 🔴 would have shipped a
broken or misleading export.

### 10.1 🔴 Header `bubbleId`s do not reliably name the stored rows

§1.3 assumes `fullConversationHeadersOnly[].bubbleId` is the key of the
matching `bubbleId:<composerId>:<bubbleId>` row. **On the probe session it
matched 5 of 88.** Its subagent matched 99 of 99.

The conversation is not damaged — the row set and the header array describe the
same 88 messages, in the same order, with identical `startedAtMs` to the
millisecond. Only the ids differ, on a session Cursor had restored from a
checkpoint (`checkpointAt` is set, `status: "aborted"`). The naive per-header
lookup therefore exported **5 blocks out of 143**, and did so silently: every
miss looked like an ordinary empty bubble.

The adapter now loads every row for a composer in one query and aligns it to the
header array by id, falling back to start time (`alignBubbles`). That resolves
88/88 and 99/99, and the headers' own `grouping` hints (`hasThinking`,
`toolCallCase`, `hasText`) agree with the resolved row's actual shape in every
case — which is what makes the timestamp fallback trustworthy rather than
merely plausible.

Rows no header claims are kept and slotted in by time, not dropped: the two
extra rows on the probe were a cancelled shell command and one the user rejected
at the approval prompt. Both are real events the header array never caught up
with.

### 10.2 🔴 `edit_file_v2` renders as an empty diff without a shared-code change

§3.4 is right that `precomputedDiff` maps directly to `DiffEntry.hunk` — the
dashboard's diff panel was correct from the start. But the **transcript** is
rendered by `formatToolInput`, which builds an Edit block from `old_string` /
`new_string`. Cursor records neither, so every edit rendered as an empty
`-`/`+` pair.

`formatToolInput` now takes the block's exact diff and uses it *when the
before/after strings are absent*, leaving Claude Code and OpenCode output
untouched. This is the only shared-code change the source required beyond the
usage flag.

### 10.3 `composerHeaders` has named columns, and an `isSubagent` flag

§1.1 reads the ten columns positionally. In Cursor 3.19 they are named:

```sql
composerId, workspaceId, createdAt, lastUpdatedAt, isArchived,
isSubagent, recency, checkpointAt, subagentTypeName, value
```

`isSubagent` and `subagentTypeName` make §2.1's subagent filtering a column
read. The adapter uses both that flag *and* the `subagentComposerIds` scan, so
it still works on a build that lacks the column.

`lastUpdatedAt` is **null** on some composers (including the probe's subagent),
so `SourceSessionRef.mtime` falls back through `recency` then `createdAt`. Using
the null directly would date the export to 1970 and make it look permanently up
to date.

### 10.4 `agentKv` blobs are SQLite BLOBs, and carry no `providerOptions`

§1.5 describes them as JSON. They are stored with `typeof(value) = 'blob'` and
must be read as bytes; the ~62% that are protobuf are skipped cheaply by testing
for a leading `{`. Their `toolName` is already near-canonical (`Read`, `Grep`,
`StrReplace`, `Shell`, `Task`).

`providerOptions.cursor.highLevelToolCallResult` — §1.5's stated route to a
rejected tool call — **is absent in 3.19**. Rejection surfaces instead on the
bubble itself, in `toolFormerData.additionalData`:

```json
{"status": "pending", "blockReason": "Pushing to main is a protected publication target…",
 "reviewData": {"status": "Requested", "selectedOption": "rejectAndTellWhatToDoDifferently"}}
```

`blockReason` is genuinely good copy and becomes the rejected block's text.

The blob join is **on by default**, not gated behind a flag as §6.2 item 10
proposed. It is one scan of a few hundred rows, and without it a `read_file_v2`
result is the stub `{"totalLinesInFile": 114}` rather than the text the model
read — too big a hole in the transcript to make opt-in.

### 10.5 `task_v2` states the subagent's type and model, in unexpected keys

§3.5 reads `params.subagent_type`. The actual keys are `subagentType`, which is
routinely the literal string `"unspecified"`, and `name`, which holds the useful
value (`"general-purpose"`). `params.model` gives the child's model as a Cursor
-internal id (`cursor-grok-4.6-high`) — unwrapped to `grok-4.6` so a spawn and
the session that spawned it resolve to one model rather than two in the legend.

`result` is `{"agentId": "…"}`, so the child link needs no prose scrape at all —
better than §3.5 suggested.

### 10.6 Errors are a JSON string, and `ripgrep_raw_search` has no `result`

`toolFormerData.error` is a JSON-encoded
`{clientVisibleErrorMessage, modelVisibleErrorMessage}`; the model-visible one
is what the transcript shows, since it is what the conversation continued from.
`ripgrep_raw_search` leaves `result` undefined and puts its match summary in
`additionalData`, which is the last fallback before rendering an empty result.

### 10.7 Model catalog: xAI added, Cursor house models deliberately not

§4.3 asks for both. `src/models.ts` gains `grok-4.6` / `4.5` / `4.3` with real
models.dev figures, plus a `grok` family fallback so an unknown variant doesn't
resolve to an Anthropic default and draw the context axis against a 1M ceiling
it never had. models.dev publishes no cache-write price for xAI, so that field
is a real zero rather than a derived guess (per the catalog rule in CLAUDE.md).

Cursor's own `composer-*` / `auto` models are **not** added: their prices are
not published anywhere this catalog can cite, a Cursor export never renders a
cost anyway, and an invented entry could mislead someone who found it here.

### 10.8 Confirmed exactly as specified

- **No usage, anywhere.** 189 bubbles across both composers, zero with a
  non-zero `tokenCount`. §4.1 is correct without qualification.
- **The WAL is not optional.** Withholding `state.vscdb-wal` from an otherwise
  identical copy loses the session's last 2 blocks and final 29 minutes.
- **No `cca-ctx` marker is emitted**, for the incidental reason §4.1.1 point 4
  predicted. The test asserts it rather than trusting it.
- **Fused call/result splitting** (§3.2, §5.5): 54 calls, 54 results, ids with
  embedded newlines round-tripping intact.
- `precomputedDiff`, `subagentComposerIds`, `supersededSubagentComposerIds`,
  `trackedGitRepos`, `promptTokenBreakdown`, `workspaceIdentifier.uri.fsPath`
  and the `workspaceStorage/*/workspace.json` mapping all behave as described.

### 10.9 Still open

§8's questions stand. `conversationState` was not decoded, so §4.5 (compaction
not observable) is accepted rather than disproved, and `timeZone` still comes
from the exporting machine rather than the binary blobs. Cloud/background agents
remain out of scope.
