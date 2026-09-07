# Spec: OpenCode export (`cca export --source opencode`)

Status: **implemented** in v1.2.0 — see `src/sources/opencode.ts`.
Author: exploration pass, 2026-09-07
Probed against: **opencode 1.18.29** (Homebrew), Node v22.14.0, macOS

Kept as the design record for the OpenCode data model. Where implementation
diverged from the plan, the section says so inline; §8 records which open
questions the build settled.

Goal: export an OpenCode session to the *same* markdown + sidecar format the
Claude Code exporter produces, so that `generate-html`, `generate-dashboard`,
`generate-simulation` and `generate-index` work on it **unchanged**.

---

## 0. TL;DR

| | |
| --- | --- |
| Feasible? | **Yes.** ~85% of the sidecar maps 1:1, and several fields map *better* than they do for Claude Code. |
| Ingestion | Read `~/.local/share/opencode/opencode.db` (SQLite) read-only via Node's built-in `node:sqlite`. **Zero new dependencies.** |
| Biggest gaps | git branch (absent), permission-mode band (semantically different), workflows (no analog), task notifications (no analog). |
| Biggest wins | real unified diffs with exact add/del counts, explicit parent→child subagent links (no regex scraping), real session titles, tool durations. |
| Prerequisite | Replace the substring price table with a models.dev-shaped catalog (§4.3). Worth landing on its own — it fixes a live 50% overcharge on Sonnet 5 in the **Claude Code** path today. |
| Blockers | none. Everything degraded has a documented fallback. |

---

## 1. Where OpenCode keeps its data

| Path | Contents |
| --- | --- |
| `~/.local/share/opencode/opencode.db` | **Everything.** SQLite, WAL mode (`-wal` / `-shm` siblings present). |
| `~/.local/share/opencode/snapshot/<projectID>/<worktreeHash>/` | Shadow **git repo** (bare-ish: `HEAD`, `objects/`, `refs/`, `index`). Every `step-start` / `step-finish` / `patch` part references a commit hash in here. |
| `~/.cache/opencode/models.json` | The **models.dev catalog** (4.5 MB, 213 providers). Per model: `cost.{input,output,cache_read,cache_write}` (USD per 1M tokens) and `limit.{context,output}`. |
| `~/.config/opencode/opencode.jsonc` | User config. `agent/` and `command/` subdirs live here when used. |
| `<project>/.opencode/` | Project-local agents/commands/plugins. (Absent in the probed project.) |

Data dir honours `XDG_DATA_HOME`; config honours `XDG_CONFIG_HOME`. The exporter
must resolve both rather than hard-coding `~/.local/share`.

### 1.1 Schema (the tables we care about)

```
project            id, worktree, vcs, name, time_created, …
project_directory  project_id, directory, type ('git_worktree'|null), strategy
session            id, project_id, parent_id, slug, directory, path, title,
                   version, share_url, summary_additions/deletions/files/diffs,
                   cost, tokens_input/output/reasoning/cache_read/cache_write,
                   permission, agent, model, time_created/updated/compacting/archived
message            id, session_id, time_created, time_updated, data (JSON)
part               id, message_id, session_id, time_created, time_updated, data (JSON)
todo               session_id, content, status, priority, position, …
```

Tables that were **empty** in the probe and should not be relied on:
`workspace`, `session_input`, `session_context_epoch`.

### 1.2 Ordering

IDs are lexicographically sortable and monotonic within their scope:

-   messages: `ORDER BY time_created, id` (matches the existing index)
-   parts: `ORDER BY id` within a message (matches `part_message_id_id_idx`)

Verified: sorting parts by `id` and by `time_created` produced identical order.
Session IDs (`ses_f850f7be…`) are **descending**-encoded — do not sort sessions by id.

### 1.3 JSON shapes

`message.data`, role `user`:

```json
{ "role": "user", "time": { "created": 1788768977964 },
  "agent": "build", "model": { "providerID": "opencode", "modelID": "big-pickle" },
  "summary": { "diffs": [ { "file": "a.txt", "patch": "Index: a.txt\n…",
                            "additions": 1, "deletions": 1, "status": "modified" } ] } }
```

`message.data`, role `assistant`:

```json
{ "parentID": "msg_…", "role": "assistant", "mode": "build", "agent": "build",
  "path": { "cwd": "/…", "root": "/…" }, "cost": 0,
  "tokens": { "total": 10160, "input": 7826, "output": 542, "reasoning": 0,
              "cache": { "write": 0, "read": 1792 } },
  "modelID": "big-pickle", "providerID": "opencode",
  "time": { "created": …, "completed": … }, "finish": "tool-calls" }
```

`part.data` — six types observed, distribution from the probe session tree
(223 tool / 39 text / 35 step-start / 35 step-finish / 18 reasoning / 1 compaction, plus `patch`):

```jsonc
{ "type": "text", "text": "…", "time": {…},
  "synthetic": true,                    // system-injected, NOT a human turn
  "metadata": { "compaction_continue": true } }

{ "type": "reasoning", "text": "…", "time": { "start": …, "end": … } }

{ "type": "step-start",  "snapshot": "<git sha in the shadow repo>" }

{ "type": "step-finish", "reason": "tool-calls", "snapshot": "<sha>",
  "cost": 0, "tokens": { "total":…, "input":…, "output":…, "reasoning":…,
                         "cache": { "write":…, "read":… } } }

{ "type": "tool", "tool": "edit", "callID": "call_…",
  "state": { "status": "completed", "input": {…}, "output": "…",
             "metadata": {…}, "title": "a.txt",
             "time": { "start": …, "end": … } } }

{ "type": "tool", "tool": "read", "callID": "call_…",
  "state": { "status": "error", "input": {…}, "error": "File not found: …",
             "time": { "start": …, "end": … } } }        // no output/metadata

{ "type": "patch", "hash": "<sha>", "files": ["/abs/path", …] }

{ "type": "compaction", "auto": true, "overflow": false, "tail_start_id": "msg_…" }
```

### 1.4 Per-tool `state.metadata`

| tool | metadata keys | notable |
| --- | --- | --- |
| `task` | `sessionId`, `parentSessionId`, `model`, `truncated` | **direct** child-session link + the subagent's model |
| `read` | `display`, `loaded`, `preview`, `truncated` | `display` carries a typed render payload |
| `glob` | `count`, `truncated` | |
| `bash` | `exit`, `output`, `truncated` | exit code available |
| `write` | `diagnostics`, `filepath`, `exists`, `truncated` | **no** `filediff` |
| `edit` | `diagnostics`, `diff`, `filediff{file,patch,additions,deletions}`, `truncated` | real unified diff + exact counts |
| `todowrite` | `todos`, `truncated` | |

Tool names are **lowercase**: `read`, `glob`, `grep`, `list`, `bash`, `edit`,
`write`, `patch`, `task`, `todowrite`, `webfetch`.

---

## 2. Ingestion strategy

### Decision: read the SQLite DB directly with `node:sqlite`

```js
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(dbPath, { readOnly: true });
```

Verified working on the installed Node v22.14.0 (emits an
`ExperimentalWarning: SQLite is an experimental feature` — suppress with
`--no-warnings` in `bin/cca`, or filter the warning). Read-only + WAL is fine:
the query returned identical counts to `opencode stats` while the DB had a
238 KB `-wal`.

**Why not the alternatives:**

| Option | Verdict |
| --- | --- |
| `opencode export <sessionID>` (official, JSON, `--sanitize` flag) | Works, and returns exactly `{info, messages:[{info, parts:[]}]}` with `parentID` on child sessions. But: spawns a full runtime per session (~1–2 s each), requires `opencode` on `PATH`, and `opencode session list` is **cwd-scoped and hides child sessions** so there is no way to enumerate a whole project without reading the DB anyway.
| `opencode serve` HTTP API | Heavier still: must boot and tear down a server. No benefit over the DB. |
| Shell out to `sqlite3(1)` | Works, but re-parses JSON in shell and adds a hard external dependency for no gain over `node:sqlite`. |

**Version risk.** The DB schema is internal and unversioned. Mitigation: read
`session.version` (e.g. `1.18.29`), mit the observed opencode version into the sidecar's `version`
field (it already carries "the tool that produced the conversation").
Read schema and emit error if schema has diverged.

### 2.1 Selecting sessions for the current project

The Claude exporter keys off `git rev-parse --show-toplevel` → mangled path
under `~/.claude/projects/`. The OpenCode analog:

```sql
SELECT id FROM project WHERE worktree = :gitRoot;
-- plus, for worktrees/sandboxes:
SELECT project_id FROM project_directory WHERE directory = :gitRoot;
```

then `SELECT * FROM session WHERE project_id = :pid AND parent_id IS NULL`
for top-level sessions, and `parent_id = :sid` (recursively) for subagents.

---

## 3. Field-by-field mapping

### 3.1 Sidecar top level

| Sidecar field | OpenCode source | Fidelity |
| --- | --- | --- |
| `uuid` | `session.id` | ✅ (but see §5.1 — the id is not hex) |
| `sessionId` | `session.id` | ✅ |
| `cwd` | `session.directory`, or assistant `message.data.path.root` | ✅ |
| `branch` | — **absent** | ⚠️ §4.1 |
| `version` | `session.version` | ✅ |
| `title` | `session.title` | ✅ **better** — OpenCode generates a real title; the Claude exporter falls back to the first prompt |
| `start` / `end` | `session.time_created` / `time_updated` (epoch ms → ISO) | ✅ |
| `durationSeconds` | derived | ✅ |
| `timeZone` | host `Intl` | ✅ |
| `stats.humanTurns` | count of `role:"user"` messages whose text parts are **not** `synthetic` | ✅ |
| `stats.linesAdded/Removed` | sum of `edit` `filediff.additions/deletions` + `write` content line count | ✅ **better** (exact, not estimated) |
| `stats.toolCounts` | bucketed tool names, see §5.2 | ✅ |
| `stats.subagent.*` | same, restricted to descendant sessions | ✅ |
| `timeline` | §3.2 | ✅ |
| `permissionSegments` | `message.data.mode` / `.agent` transitions | ⚠️ §4.2 |
| `subagents` | `task` tool parts | ✅ **better** |
| `subagentUsageByModel` | descendant sessions' `step-finish` tokens, keyed `provider/model` | ✅ |
| `diffs` | §3.3 | ✅ **better** |
| `setup` | §4.5 | ⚠️ |

### 3.2 Timeline points

| `kind` | Source |
| --- | --- |
| `prompt` | `role:"user"` message, non-synthetic `text` part. `label` = `truncate(text, 400)`. |
| `assistant` | `role:"assistant"`, `text` part. |
| `thinking` | `reasoning` part. |
| `tool_use` | `tool` part. `tool` = the (mapped) tool name. |
| `tool_result` | Emit a synthetic point per completed `tool` part; `outChars = state.output.length`. |
| `skill` | `synthetic: true` text parts, and command/slash invocations. |
| `notification` | **no analog** — see §4.4. |
| *(new)* `compaction` | `compaction` part. Currently no slot; see §6.3. |

`t` (seconds from session start): use `part.time_created` (always present on the
row, even when the JSON body has no `time`).

`usage`: attach to the *first* `tool_use`/`assistant` point of each step, taken
from that step's `step-finish` part:

```
in = tokens.input, out = tokens.output, cw = tokens.cache.write, cr = tokens.cache.read
```

> **Use `step-finish` parts, not `message.tokens`.** In the probe they were 1:1
> (one step per assistant message) and identical, but a message *can* contain
> several steps, in which case `message.tokens` reflects only the last one and
> the context-window curve would be wrong.

Context window per call = `in + cw + cr`, exactly as today. Verified sane on real
data: a session climbed `128+4352 → 1753+4480 → … → 12710+59968`, then took a
cache miss (`77286+0`) and re-warmed (`1962+77056`) — the curve renders correctly.

`model`: `providerID + "/" + modelID` (e.g. `opencode/big-pickle`,
`anthropic/claude-opus-5`). See §4.3 for why the bare model id is not enough.

`subagentModel`: `task` part's `state.metadata.model` — **direct**, no need for
the Claude exporter's `agentId:` regex scrape of the tool result.

### 3.3 Diffs

This is where OpenCode is strictly better than Claude Code.

-   Per edit: `tool.state.metadata.filediff = { file, patch, additions, deletions }`
  — a real unified diff plus **exact** counts. The Claude exporter approximates
  by counting lines in `old_string` / `new_string`.
-   Per turn: the **user** message carries `data.summary.diffs[]` — the cumulative
  diff for the whole turn, with `status: "modified" | …`, paths relative to the
  project root.
-   Per step: `patch` parts (`{hash, files[]}`) and `step-start/finish.snapshot`
  reference commits in the shadow git repo, so a full `git diff` between any two
  points is recoverable.

Mapping to `DiffEntry`:

```
op        "Edit"  (tool 'edit'/'patch')  |  "Write" (tool 'write')
filePath  filediff.file / input.filePath
added     filediff.additions   | write: content line count
removed   filediff.deletions   | write: 0
hunk      parse filediff.patch → DiffLine[] ('+'→add, '-'→del, ' '→ctx),
          skipping the `Index:/---/+++/@@` header lines, capped at 40 lines
origin    "main" | "subagent"  (by session depth)
```

`write` has **no** `filediff`, so keep the current Write handling (count lines
in `input.content`).

Caveat: `session.summary_additions/deletions/files` were `0` even after a
successful edit — **do not use the session-level rollup**; aggregate from parts.

### 3.4 Markdown blocks

The three HTML generators key *only* on the block headings and the embedded
sidecar JSON — `classify()` in `generate-html.ts:160` matches on emoji/label
substrings. **Emitting the same headings means all downstream renderers work
with zero changes.** Required output:

| Heading | From |
| --- | --- |
| `## 🧑 User` | user text part |
| `## 🤖 Assistant` | assistant text part |
| `## 🧠 Thinking` | `reasoning` part |
| `## ⚪️ Tool Call: <name>` | `tool` part, `state.input` |
| `## 🟢 Tool Result: <name>` | `tool` part, `state.output` |
| `## 🔴 Tool Error: <name>` | `tool` part, `state.status === "error"` → `state.error` |
| `## ❌ Tool Rejected: <name>` | `state.status === "rejected"` (not observed; handle defensively) |
| `## 📜 Skill Prompt` | synthetic text parts |
| `## 🔔 Task Notification` | *(never emitted — no analog)* |

Plus the two hidden markers, unchanged:
`<!--cca-ctx:N-->` on each heading, and `[[agent:<id>]]` appended to a `task`
spawn block — where `<id>` is `state.metadata.sessionId`, which is *exactly* the
filename stem used for the child export. Cleaner than the Claude path.

---

## 4. What does **not** work (and what to do about it)

### 4.1 git branch — **absent** ⚠️

Claude Code stamps `gitBranch` on every jsonl line; the exporter takes the modal
value and uses it as an **output directory component**
(`<target>/<user>/<branch>/…`) and as a sidecar field.

OpenCode records **no branch anywhere**. `session.directory` and
`project.worktree` are paths; the `workspace` table (which does have a `branch`
column) was **empty**. `project_directory` only marks `type = 'git_worktree'`.

Options, in preference order:

1. **Read it from the shadow snapshot repo.** `step-start.snapshot` is a commit
   in `~/.local/share/opencode/snapshot/<projectID>/<hash>/`; that repo's
   `HEAD`/`refs` may name the branch at snapshot time.
2. **Emit `unknown`** and flatten the directory layout for OpenCode exports.

**Resolved (implementation).** Option (1) does not work: the shadow repo's `HEAD`
is an unborn `refs/heads/main` — git's default init branch — with *no refs at
all* (`packed-refs` is an empty header, `refs/heads` is empty). Verified across
all three snapshot repos on the probe machine, including one whose real project
was on a different branch. It never names the branch at snapshot time.

What the shadow repo *does* carry is `core.worktree`, pointing at the real
working tree. So the adapter reads that tree's branch **now**
(`git rev-parse --abbrev-ref HEAD` in `session.directory`) and stamps
`branchSource: "live-git"`, falling back to `branch: "unknown"` /
`branchSource: "unknown"` when the directory is gone or not a repo. This keeps
OpenCode exports in the same `<user>/<branch>/` tier as the Claude ones — which
is what makes the side-by-side comparison in §6.2 work — while recording in the
sidecar that the value is a current reading, not a historical one.

### 4.2 Permission-mode band — **semantically different** ⚠️

The dashboard renders a colour band from `permissionSegments`, built from Claude
Code's `permissionMode` (`default` / `plan` / `acceptEdits` / `bypassPermissions`,
labelled in `MODE_LABELS`).

OpenCode has no such per-message field. The closest signals:

-   `message.data.mode` and `message.data.agent` — `build`, `plan`, `explore`, or a
  custom agent name. Present on every assistant message.
-   `session.permission` — a static allow/ask/deny rule array (observed on the
  subagent sessions: `todowrite:deny`, `task:deny`), not a timeline.
-   `--auto` (auto-approve) is a process flag and is **not recorded at all**.

Recommendation: **repurpose the band as "agent / mode"**, built from `mode`
transitions, and relabel it in the dashboard when the sidecar says the source is
OpenCode. `plan` maps naturally onto the existing 📝 Plan label; `build` onto
⌨️ Normal; other agents get generated labels/colours. Do **not** claim it shows
permission posture — it doesn't.

**Implemented** as `AGENT_MODE_META` in `generate-dashboard.ts`, selected by
`Sidecar.source`, with the caption next to the timeline reading "Band: active
agent / mode." instead of "Band: permission mode." Custom agents fall back to
their own name and a hue hashed from it.

### 4.3 Cost — **free model in the probe; the price table needs replacing** ⚠️

Two separate things, and only one of them is a defect.

**(a) The observed `cost: 0` is correct.** The probe ran on
`opencode/big-pickle`, a **free** model, so `0` is the right answer and
`opencode stats` agreeing (`Total Cost $0.00` across 611 K input / 1.3 M
cache-read) is exactly what should happen. Cost recording for *paid* providers
was simply **not observable in this probe** — it is unverified, not broken. Before
relying on `session.cost` / `message.cost` / `step-finish.cost`, run one session
against a BYO-key provider and confirm they populate (tracked in §8).

**(b) The analyzer's price table is a real defect — today, for Claude Code.**
`generate-dashboard.ts:99` and `generate-simulation.ts:56` hold **duplicate**
tables that match model ids by substring and derive cache prices as
`cw = 1.25 × input`, `cr = 0.1 × input`. Measured against the model ids actually
present in `~/.claude/projects` (1 538 assistant messages):

| model id | calls | table charges | models.dev says | error |
| --- | --- | --- | --- | --- |
| `claude-opus-5` | 1065 | 5 / 25 | 5 / 25 | ok |
| `claude-opus-4-8` | 379 | 5 / 25 | 5 / 25 | ok |
| `claude-sonnet-5` | 80 | 3 / 15 | **2 / 10** | **+50% overcharge** |
| `claude-haiku-4-5-20251001` | 11 | 1 / 5 | 1 / 5 | ok |
| `<synthetic>` | 3 | 5 / 25 (Opus fallback) | n/a | should be **0** |

The derived cache prices are wrong wherever the ratio doesn't hold —
`claude-fable-5-1` lists `cache_read: 0.25` while the `0.1 × input` rule computes
`1.0`, a **4× overcharge** on cache reads. And context limits are per-model
(`claude-opus-4-5` 200 K vs `claude-opus-4-6`+ 1 M; haiku 200 K), which the
hardcoded heuristic in §5.4 only approximates.

Adding OpenCode makes this worse, not different: against `big-pickle`, `glm-4.7`,
`gpt-5-codex`, `minimax-m2.1` … *every* model falls through to the Opus default.

#### Strategy: adopt the models.dev schema as the internal format

New `src/models.ts` holding a catalog keyed by model id, using models.dev field
names **verbatim** — the same shape OpenCode already ships at
`~/.cache/opencode/models.json`. Entries then copy across in either direction and
can be refreshed from upstream without reshaping anything.

```ts
export interface ModelCost {
  input: number;        // USD per 1M tokens
  output: number;
  cache_read: number;
  cache_write: number;
}
export interface ModelLimit { context: number; output: number }
export interface ModelEntry {
  id: string; name: string; family: string;
  limit: ModelLimit;
  cost: ModelCost;
}
export const MODELS: Record<string, ModelEntry>;
```

Seeded with the 14 Anthropic entries from models.dev, copied as-is:

```ts
"claude-sonnet-5": {
  id: "claude-sonnet-5", name: "Claude Sonnet 5", family: "claude-sonnet",
  limit: { context: 1_000_000, output: 128_000 },
  cost: { input: 2, output: 10, cache_read: 0.2, cache_write: 2.5 },
},
```

Resolution order for an arbitrary model string:

1. exact id hit in `MODELS`
2. strip a trailing variant suffix (`claude-opus-5[1m]` → `claude-opus-5`), retry
3. ordered family fallback by substring (`fable` → `claude-fable-5-1`,
   `mythos` → fable pricing, `opus` → `claude-opus-5`, `sonnet` →
   `claude-sonnet-5`, `haiku` → `claude-haiku-4-5`)
4. `DEFAULT_MODEL_ID`

Plus one local zero-cost `<synthetic>` entry — Claude Code writes that literal
model id and it currently prices as Opus.

One exported `costOf`, using the catalog's **explicit** cache prices rather than
the `1.25×` / `0.1×` derivation:

```ts
cost = (u.in * c.input + u.out * c.output
      + u.cw * c.cache_write + u.cr * c.cache_read) / 1e6;
```

Consumers:

- **`generate-dashboard.ts`** — delete its `PRICES` / `priceFor` / `costOf`,
  import from `models.ts`. Replace the hardcoded `ctxLimit` (§5.4) with
  `max(limit.context)` across `cc.models`.
- **`generate-simulation.ts`** — delete its duplicate table. It ships pricing to
  the **browser** (`prices: PRICES, def: DEFAULT_PRICE` at `:546`, mirrored
  client-side at `:698` with the multipliers hardcoded a *third* time). Change the
  payload to a **resolved** map covering only the models in this session:
  ```js
  costs: { "claude-opus-5": { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 }, … }
  ```
  The client then does a plain lookup — no substring matching, no multipliers.
- **`MODEL_COLOR_BY_MATCH`** (§5.5) keys off the resolved `family` instead of
  running its own substring match.

Maintenance becomes "copy the provider block out of models.dev". A small
`npm run sync-models` helper can read `~/.cache/opencode/models.json` when
present and print the refreshed catalog literal for review — but the
**checked-in catalog stays authoritative**, so exports remain reproducible on
machines with no OpenCode installed.

For OpenCode, the same `ModelEntry` shape is filled from
`~/.cache/opencode/models.json` at export time for non-Anthropic providers, keyed
`provider/model`, and embedded in the sidecar (§6.3) so reports stay accurate
without the catalog having to know every provider on models.dev.

Display order for cost, once a source records it: recorded `step-finish.cost`
when non-zero → catalog price × tokens. Render a free/subscription model as an
explicit `$0` state rather than a blank or a fabricated number.

### 4.4 Task notifications — **no analog** ✅ (harmless)

Claude Code's `Agent`/`Task` is asynchronous and posts `<task-notification>`
messages back into the transcript. OpenCode's `task` tool is **synchronous** —
the child's final text is embedded in `state.output` as
`<task id="ses_…" state="completed"><task_result>…</task_result></task>`.

Consequence: the `notification` timeline kind and the `## 🔔 Task Notification`
block are simply never emitted. No work needed; the dashboard already handles a
zero count. Worth parsing the `<task id>` attribute as a *second* source for the
child session id (belt and braces alongside `metadata.sessionId`).

### 4.5 Setup panel (agents / skills) — **partial** ⚠️

`readSetupDir()` scans `<dir>/agents/*.md` and `<dir>/skills/*/SKILL.md` for
frontmatter. OpenCode's equivalents live in different places and formats:

-   built-in agents (`build`, `plan`, `explore`, `general`) — not files at all;
  `opencode agent list` prints them
-   `~/.config/opencode/agent/*.md` and `<project>/.opencode/agent/*.md`
-   `agent` blocks inside `opencode.json(c)`
-   `AGENTS.md` (project instructions, the `CLAUDE.md` analog)
-   OpenCode has **no `skills` concept**

Interesting wrinkle observed in `opencode agent list`: this user's OpenCode
config grants `external_directory` allow-rules for
`/Users/marek/.claude/skills/graphify/*`, `…/chanel-viz-palette/*`,
`…/project-bootstrap/*` — i.e. OpenCode is reaching into the *Claude* skills
directory. So the existing user-level skill scan is still meaningful; only the
agent scan needs a new source.

Recommendation: keep `SetupItem.kind` and add `"command"` / `"plugin"`; populate
agents from the config dirs + `opencode.json(c)`; keep scanning `~/.claude/skills`
when it exists (it's genuinely in use).

### 4.6 Workflows — **no analog** ✅ (harmless)

There is no OpenCode equivalent of Claude Code's `Workflow` tool. The
`<ts>-<prefix>-workflows/` output tier is never created, and `IndexEntry.kind`
never takes the value `"workflow"`. Subagent nesting *can* be deeper than
Claude's (a child session can itself spawn children), so the index's
`children[]` must be built recursively rather than assumed one level deep.

### 4.7 Cache-write unobserved; reasoning tokens have no slot ⚠️

`tokens.cache.write` was `0` on every step of the probe. As with cost (§4.3a),
this is **one free model on one provider** and generalises to nothing — it may be
how that provider reports, or that no cache write happened. Don't design around
it; re-check on a paid provider. If some providers genuinely never report cache
writes, the dashboard should say so rather than draw a flat line implying "no
caching".

`tokens.reasoning` is tracked separately by OpenCode and the `Usage` type
(`{in, out, cw, cr}`) has nowhere to put it. Choose one:

- fold into `out` (simplest, slightly overstates output cost for models that
  bill reasoning separately), **or**
- extend `Usage` with `rz` — additive, but every consumer must default it to 0.

Recommendation: fold into `out` for v1, note it in the sidecar, revisit if a
provider prices reasoning distinctly.

**Implemented**: folded into `out` in `normTokens()` (`sources/opencode.ts`).

---

## 5. Concrete breakages in existing code

These are places the current code will *silently* misbehave on OpenCode input.
Each needs a change, not just a new file.

### 5.1 `findExistingExports()` — re-export detection breaks 🔴

`src/export-claude-history.ts:645`:

```js
/^(\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2})-([a-f0-9]{8})\.(md|txt)$/
```

OpenCode ids are `ses_f850f7be5ffeoAH3HDH0QmOYze` — mixed case, non-hex, with a
`ses_` prefix. The `[a-f0-9]{8}` group never matches, so **no prior export is
ever recognised**: every run re-exports everything and stale duplicates
accumulate (which then also breaks the "more than one means clean up" branch).

Fix: Widen the regex to `([a-zA-Z0-9_]{8,32})` and use
`session.id.replace(/^ses_/, "").slice(0, 8)`.

**Implemented** with an `oc` tag on the stem (`oc` + 8 chars, e.g.
`ocf850f7be`), so a filename says which agent produced it and the two sources
can share a branch directory without any chance of collision. The widened
pattern still matches Claude Code's existing 8-hex stems unchanged, so prior
exports keep being recognised.

### 5.2 `TOOL_BUCKETS` — every tool counts as "other" 🔴

`src/export-claude-history.ts:922` is keyed `Read` / `Glob` / `Grep` / `Bash` /
`Edit` / `MultiEdit` / `Write`. OpenCode emits **lowercase** names. Result:
`toolCounts.other` absorbs 100% of activity and the read/search/bash/edit split
in the dashboard is empty.

Fix: normalise on lookup (`TOOL_BUCKETS[name] ?? TOOL_BUCKETS[titleCase(name)]`)
or add the lowercase keys plus `list → read`, `patch → edit`, `webfetch → other`,
`todowrite → other`, `task → other`.

**Implemented** as a two-part fix: `TOOL_BUCKETS` is keyed lowercase and looked
up through `bucketOf()`, *and* the OpenCode adapter maps its names onto the
canonical set (`TOOL_MAP`) while keeping the source's own name as the display
name. Verified against `opencode stats` on the probe tree: 188 read, 26 glob,
6 bash, 3 task — exact match.

### 5.3 `formatToolInput()` — tool inputs render as raw JSON 🟠

`src/export-claude-history.ts:245` switches on `Write` / `Edit` / `Bash` /
`Read` / `Glob` / `Grep` / `Agent` and destructures **snake_case** keys
(`file_path`, `old_string`, `new_string`, `command`, `pattern`).

OpenCode uses **camelCase** (`filePath`, `oldString`, `newString`) and lowercase
tool names, so every call falls through to
`default: truncate(JSON.stringify(input), 500)` — readable, but the discussion
viewer loses its syntax-highlighted diffs and code blocks.

Fix: add an input-normalisation step per source, mapping OpenCode's shape onto
the existing canonical keys before formatting. Keep `formatToolInput` itself
source-agnostic.

**Implemented** as `normalizeInput()` in `sources/opencode.ts`.

### 5.4 Context-window limit is hard-coded 🟠

`src/generate-dashboard.ts:301`:

```js
const ctxLimit = cc.peakContext > 200_000 ? 1_000_000 : 200_000;
```

Wrong for `claude-opus-4-5` (200 K) as soon as any 1 M-context model appears in
the same session, and wrong for most OpenCode models. Fixed by the catalog in
§4.3: take `max(limit.context)` across the models the session actually used, and
prefer the sidecar's embedded value when the source supplied one.

### 5.5 Model colours 🟡

`MODEL_COLOR_BY_MATCH` (`generate-dashboard.ts:120`) runs a *third* substring
match over opus/sonnet/haiku. With many OpenCode providers it collapses to one
colour. Fix: key off the `family` the §4.3 catalog already resolves, and hash
`provider/model` to a stable hue when the family is unknown.

### 5.6 `dominantModelOf()` / `sumUsageByModel()` are jsonl-shaped 🟡

Both walk `agent-*.jsonl` files (`export-claude-history.ts:788`, `:808`). The
OpenCode path replaces them with DB queries over descendant sessions. Extract
the *aggregation* logic from the *reading* logic so both sources share it.

---

## 6. Implementation plan

### 6.1 Shape: a source adapter, not a fork

Refactor rather than copy. Target layout:

```
src/
  sources/
    types.ts          # the neutral intermediate: Session, Msg, Part, ToolCall
    claude.ts         # existing jsonl reader, moved
    opencode.ts       # new: node:sqlite reader
  export-history.ts   # renamed from export-claude-history.ts; source-agnostic
                      # markdown + sidecar builder (parseConversation/buildSidecar)
  models.ts           # new: models.dev-shaped catalog + costOf (§4.3)
  version.ts          # unchanged
  generate-*.ts       # unchanged except §5.4 / §5.5
```

The neutral intermediate should be modelled on what `buildSidecar` already
consumes, so `parseConversation` and `buildSidecar` change only where §5 says so.

`export-claude-history.ts` stays as a thin alias for backward compatibility,
matching how `cca-export` already aliases `cca export`.

### 6.2 CLI surface

```
cca export <target-dir> [--full] [--source claude|opencode|auto]
                        [--claude-dir <path>] [--opencode-dir <path>]
```

-   `--source auto` (default): export from whichever sources have sessions for the
  current git root. If both do, export both — into `<target>/<user>/<branch>/`
  with a source suffix in the filename so they can't collide, and let
  `generate-index` list them side by side. Comparing the *same task* across
  Claude Code and OpenCode is arguably the most interesting thing this feature
  enables; the index already supports per-row selection and live-summed totals.
-   `--opencode-dir` mirrors `--claude-dir` and overrides the XDG data dir.

### 6.3 Sidecar changes

All additive; `CCA_DATA_VERSION` stays at `1`, tool version gets a **MINOR** bump.

```ts
interface Sidecar {
  …
  source?: "claude-code" | "opencode";   // absent ⇒ "claude-code"
  models?: Record<string, ModelEntry>;   // key: "<provider>/<model>"; models.dev
                                         // shape, verbatim (§4.3). Only for
                                         // models absent from the built-in catalog.
  branchSource?: "snapshot" | "live-git" | "unknown";
}
type TimelinePoint["kind"] = … | "compaction";
```

Every consumer must treat all four as optional.

### 6.4 Ordered work items

All landed in v1.2.0:

1. ✅ Extract `sources/types.ts` + move the jsonl reader to `sources/claude.ts`.
   Verified byte-identical on two frozen `~/.claude` fixtures (one of them with
   subagent transcripts), not just `sample-report/`.
2. ✅ `sources/opencode.ts` (DB reader → neutral intermediate), with an up-front
   schema check that names the missing table/column rather than exporting a
   half-empty conversation after an upstream change.
3. ✅ §5.1, §5.2, §5.3.
4. ✅ `models.ts` + per-export catalog entries in the sidecar; §5.4 and §5.5.
5. ✅ Recursive subagent export via the `parent_id` walk, with
   `[[agent:<sessionId>]]` links; `buildAgentHrefMap` also scans a transcript's
   own directory so a grandchild link resolves from inside a subagent page.
6. ✅ Diff extraction from `filediff.patch` → `DiffEntry.hunk`.
7. ✅ Branch resolution, with the strategy recorded (§4.1).
8. ✅ Agent/mode band relabelling (§4.2) + setup panel sources (§4.5).
9. ✅ `compaction` timeline kind + a 🗜️ marker in the discussion viewer.

One thing the plan did not anticipate: **per-block timestamps**. OpenCode stamps
every part, and every tool call's `start` and `end`, so `NeutralBlock.ts` was
added and the timeline places each call and result at its real offset. That is
what makes parallel subagent spawns show as genuinely overlapping, and gives the
simulator a true wall-clock per tool instead of one shared message timestamp.
Claude Code sets no block timestamps and falls back to the message's, unchanged.

---

## 7. Test plan

What was actually run for v1.2.0:

-   **Claude regression (the important one)**: two frozen copies of
  `~/.claude/projects/<project>` — this repo's (3 sessions) and one with a
  subagent transcript — exported with the pre-refactor code and with the new
  source-agnostic exporter, then `diff -r`'d. **Byte-identical**, `.md` and
  `.json`. This caught one real regression on the way: dropping assistant
  messages that render to nothing also dropped their token usage from
  `subagentUsageByModel`.
-   **Cross-check against `opencode stats`**: the exported tool tallies match
  exactly — 188 read, 26 glob, 6 bash, 3 task across the probe session tree.
-   **End to end**: the probe tree (1 parent + 3 `explore` children, 41 messages,
  351 parts, one auto-compaction) exports, renders all three report types, nests
  its subagents in the index, resolves its `[[agent:…]]` links, prices at `$0`
  on a free model, and draws the context axis at the model's real 200 K limit.
-   **Idempotency**: a second export is a no-op (`0 conversation(s) exported`),
  i.e. the widened `findExistingExports` pattern recognises OpenCode stems.
-   **Visual**: per `AGENTS.md`, the generated HTML is opened for review rather
  than driven with a browser.

Not yet covered, and worth adding when the data exists: a committed fixture (a
small anonymised DB, or `opencode export` JSON) so this runs without the
author's machine, and a session on a paid provider (§8.6).

## 8. Open questions

Settled by the implementation:

1. ~~**Branch at snapshot time**~~ — **answered: no.** The shadow repo's HEAD is
   an unborn `refs/heads/main` with no refs; it never names the real branch.
   §4.1 now reads the live working tree instead and records `branchSource`.
2. ~~**Multi-step assistant messages**~~ — **handled structurally.** The adapter
   splits an assistant message into one neutral message *per step*
   (`step-start` … `step-finish`), so each step carries its own `step-finish`
   tokens. This is correct whether a message has one step or twenty, and does not
   depend on ever observing a multi-step message.

Still open — they need data this machine cannot produce:

3. **Rejected tool calls** — only `completed` and `error` were observed. The
   adapter matches `/reject|denied|deny/i` against `state.status` and emits
   `## ❌ Tool Rejected` defensively; the real string is unconfirmed.
4. **Compacted sessions** — the context curve is currently drawn continuously
   through a compaction, with a 🗜️ marker on the timeline and in the transcript
   at that point. Whether it should instead reset to the tail is a display
   question, not a data one.
5. **`--sanitize`** — not exposed. `opencode export --sanitize` redacts
   transcript and file data; worth revisiting if reports get shared outward.
6. **Does OpenCode record cost for paid providers?** Still unverified — the probe
   ran on a free model, where `cost: 0` is correct. The exporter does not read
   `step-finish.cost` at all today: it prices from tokens × the catalog, which is
   right for the free case (models.dev lists `big-pickle` at 0, and the report
   shows an honest `$0`) and is the same path the Claude Code side uses.
7. **Cache-write unobserved** (§4.7) — every step of the probe reported
   `cache.write: 0`. One session on a paid provider settles both this and (6).

## 9. Appendix: probe notes

Two throwaway OpenCode sessions were run to capture the `write` / `edit` /
`todowrite` / error part shapes, since the existing session tree was read-only.
Both sessions and their scratch files were deleted afterwards
(`opencode session delete`); one stray `b.txt` that OpenCode wrote to
`~/Documents/Projets/` (it resolved the project root above the intended scratch
dir) was removed. The four MarekAI sessions are untouched.
