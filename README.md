# coding-conversation-analyzer

Export coding-agent conversations into readable markdown, then turn them into an
interactive HTML viewer for analysis. Two agents are supported, and both land in the
same format so a single index can list them side by side:

- **[Claude Code](https://claude.com/claude-code)** — the jsonl transcripts under `~/.claude/projects/`
- **[OpenCode](https://opencode.ai)** — the SQLite database at `$XDG_DATA_HOME/opencode/opencode.db`

Two steps, both run through the **`cca`** CLI (see [Install](#install)):

1. **`cca export`** — dumps conversations to markdown (plus a structured
   JSON sidecar), organized by git branch.
2. **`cca generate-html`** — converts a markdown export into three reports: a three-column
   interactive **discussion viewer**, a metrics **dashboard**, and a token/cost/time
   **simulation** page.

Under the hood these are standalone, self-contained TypeScript scripts using only
Node built-ins, run with [`tsx`](https://github.com/privatenumber/tsx) — no build step.

## Install

### One-liner (recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/theodo-group/coding-conversation-analyzer/main/install.sh | bash
```

This clones the repo to `~/.coding-conversation-analyzer`, installs dependencies, and
puts the **`cca`** command on your PATH with three subcommands:

```bash
cca export <output-dir>              # export conversations to markdown
cca generate-html <input> [output]   # render a markdown export to HTML
cca update                           # update to the latest version
cca --version                        # print the installed version
```

The standalone aliases `cca-export` and `cca-generate-html` are also installed for
backward compatibility. Re-run the one-liner — or `cca update` — any time to update;
it's a no-op when you're already on the latest version.

Override the defaults with env vars if needed:

```bash
INSTALL_DIR=~/tools/cca BIN_DIR=~/bin \
  bash -c "$(curl -fsSL https://raw.githubusercontent.com/theodo-group/coding-conversation-analyzer/main/install.sh)"
```

Requires Node.js 18+. If `~/.local/bin` isn't on your PATH, the installer prints the line
to add to your shell profile.

### Manual (from a clone)

```bash
git clone https://github.com/theodo-group/coding-conversation-analyzer.git
cd coding-conversation-analyzer
npm install
```

Then run the scripts with `npm run export` / `npm run view`, or a global `tsx` (`npm i -g tsx`).

## 1. Export conversations

```bash
cca export <output-dir>                      # if installed via the one-liner
# or, from a clone:
npm run export -- <output-dir>
# or: tsx src/export-history.ts <output-dir>
```

Exports conversations including tool results, thinking blocks, subagent conversations,
actual Edit diffs, and YAML frontmatter. Incremental — re-running only exports new or
changed conversations.

### Choosing a source

By default (`--source auto`) every agent that has sessions for the current git root is
exported, so a task done twice — once in Claude Code, once in OpenCode — shows up as two
rows in the same index, directly comparable. Restrict it with `--source`:

```bash
cca export <output-dir> --source claude     # Claude Code only
cca export <output-dir> --source opencode   # OpenCode only
```

OpenCode's database is read **read-only** through Node's built-in `node:sqlite`, which is
safe while OpenCode is running. Filenames are unambiguous per source: Claude sessions use
their 8-character uuid prefix, OpenCode sessions an `oc`-tagged session id
(`…-ocf850f7be.md`).

A few things differ because the sources differ, and the reports say so rather than
pretending otherwise:

| | Claude Code | OpenCode |
| --- | --- | --- |
| Branch | recorded per message | **not recorded** — read from the working tree now, and stamped `branchSource: "live-git"` |
| Timeline band | permission mode (Normal / Plan / Auto-accept / Bypass) | active **agent / mode** (build, plan, explore, …) — a different thing, labelled differently |
| Diffs | approximated from the edit's before/after strings | real unified diffs with exact add/delete counts |
| Subagent links | scraped from the spawn's result text | stated outright, and nested arbitrarily deep |
| Task notifications / workflows | present | no analog — simply never emitted |
| Compaction | — | marked on the transcript and the timeline (🗜️) |

Long tool results are truncated by default. Pass `--full` to export them in full:

```bash
cca export <output-dir> --full
```

By default it reads Claude Code's history from `~/.claude` and OpenCode's from
`$XDG_DATA_HOME/opencode` (i.e. `~/.local/share/opencode`). Pass `--claude-dir <path>` or
`--opencode-dir <path>` (`=<path>` also works, `~` is expanded) to read from a different
location — useful for a non-standard `CLAUDE_CONFIG_DIR`, a backup, or another machine's
history:

```bash
cca export <output-dir> --claude-dir /path/to/.claude
cca export <output-dir> --opencode-dir /path/to/opencode
```

Output structure:

```
<output-dir>/
  <git-user>/
    <branch>/
      2026-03-01-12-58-08-479c0b78.md
      2026-03-01-12-58-08-479c0b78.json          # sidecar: usage, cost inputs, timeline, diffs, setup
      2026-03-01-12-58-08-479c0b78-subagents/
        agent-abc123.md
```

This structured data — per-message token usage, model, timestamps, permission-mode
timeline, edit diffs, subagent token totals, and the active agents/skills config — is
what the markdown body drops. It is embedded directly in the `.md` as a trailing hidden
HTML comment (`<!-- cca:data … -->`, invisible in any rendered markdown), so a single
`.md` is **self-contained**: it renders both the discussion and the dashboard on its own.
The same data is also written as a sibling `.json` **sidecar** for backward compatibility
and for tooling that wants the raw metrics without parsing the markdown.

## 2. Generate the HTML viewer

```bash
cca generate-html <input.md | input-dir> [output.html | output-dir]  # if installed via the one-liner
# or, from a clone:
npm run view -- <input.md | input-dir> [output.html | output-dir]
# or: tsx src/generate-html.ts <input.md | input-dir> [output.html | output-dir]
```

Each markdown input produces up to **three** files, side by side:

- `<name>-discussion.html` — the three-column interactive viewer (always written)
- `<name>-dashboard.html` — the metrics dashboard (written whenever the source `.md`
  carries an embedded `cca:data` block, or a `<name>.json` sidecar sits next to it)
- `<name>-simulation.html` — the **token/cost/time simulator** (written under the same
  condition as the dashboard; see below)

If the input is a single `.md` file and the output argument is omitted, the files
default to `<input_basename>-discussion.html`, `-dashboard.html` and `-simulation.html`.

### Simulation page

The simulator is a **learning tool**: a linear transcript of the conversation with a
checkbox on every tool call. Unchecking a tool simulates never having run it — its
result stops riding along in every later prompt — and a sticky side panel recomputes
the session's **cost, peak context and duration** live in the browser.

It is an *accounting* model over the real token usage, not a counterfactual: it assumes
the same conversation trajectory, only with cheaper context, and offers no advice.
A tool's context weight is derived by differencing the context size of consecutive API
calls (`input + cache_creation + cache_read`) and subtracting the known output tokens;
that weight is then removed from every later call — split across each call's
cache-write / cache-read in proportion to its actual `cw:cr`, so a cache-expiry re-write
credits the full 1.25× write, a normal cached read credits 0.1×. Cost is priced
identically to the dashboard.

A lone tool in a turn takes that turn's exact differenced weight. Tools that share a
turn are each sized from their own result length (via a chars→tokens ratio calibrated
from the session's single-tool turns), marked with a `*`. When a turn grows by more than
its tool *results* carry — a **Skill** loading its body, a **Task/Agent** subagent
spawn, an **MCP** call returning a large resource — that unexplained residual is
attributed to the injector call, so unchecking it removes the context it actually caused
(e.g. a `/graphify` skill load that added ~200k tokens). Growth with no identifiable
injector (a pasted message, say) is left unattributed rather than guessed.

If the input is a **directory**, every `.md`/`.markdown` file inside is converted
**recursively**, writing both files next to each source — or mirroring the directory tree
under `output-dir` if a second argument is given. An **`index.html`** is also written at
the output root (see below).

### Index page (directory mode)

Converting a directory writes an `index.html` at the output root listing every
conversation in one table — **title, cost, max context, duration, and change**
(lines added/removed) — with links to each conversation's discussion, dashboard and
simulation reports.

Each row has a checkbox (ticked by default). A sticky totals bar live-sums the
selection so several sessions on one feature can be analyzed as a group: cost,
duration, and change are **summed**, while max context shows the **peak** reached
across the selection. "Select all" / "Clear" toggle the whole list.

Metrics come from each conversation's `.json` sidecar. A markdown file with no
sidecar next to it is still listed (with its discussion link) but shows `—` and no
checkbox, since it has no metrics or dashboard.

### Discussion viewer features

- Three-column grid layout: **Input** | **Assistant** | **Tools**
  - **Input**: your prompts (🧑); teammate/inter-agent messages (🤝, accent-colored per
    teammate with an id label, JSON payloads rendered as a key/value grid and a `summary`
    chip); local commands (⌨️, e.g. `/compact`); and subagent task notifications (🔔)
  - **Assistant**: replies (🤖) and thinking (🧠)
  - **Tools**: calls (⚪️), results (🟢), errors (🔴), and skill prompts (📜)
  - Context compaction, where the source records it, is marked in the Input column (🗜️)
- Per-subtype counters in each column header (e.g. `14 🧑 · 14 🤝 · 4 ⌨️ · 3 🔔`)
- Collapsible cards with turn-based grouping
- Navigation buttons to jump between messages of the same subtype
- Tool results, errors, and skill prompts collapsed by default
- Dark theme with color-coded message types

### Dashboard features

Same dark theme, a single-page metrics report generated from the JSON sidecar:

- Summary tiles: duration, human turns, lines added/removed, tool-call breakdown
- **Cost & context** chart — spend and context-window usage over the conversation,
  per model. Cost is **computed** from token usage, since it isn't stored in the
  transcript: prices and context limits come from a [models.dev](https://models.dev)-shaped
  catalog (`src/models.ts`) with each model's own explicit cache-read/cache-write prices.
  Models from providers the built-in catalog doesn't cover ride along in the export's
  sidecar, so an OpenCode session on any provider still prices correctly — including
  free models, which show an honest `$0`. The context-window axis is the largest limit
  across the models the session actually used
- Message timeline with a thinking-blocks toggle and a band showing the permission mode
  (Claude Code) or the active agent/mode (OpenCode)
- Spawned subagents, with per-model token totals
- Generated diffs from `Write`/`Edit` tool calls
- **Setup** panel — the agents and skills active for the run. Read from the current
  config (`.claude` for Claude Code; `agent/`, `command/` and `opencode.json(c)` plus
  `AGENTS.md` for OpenCode), so it reflects config *now*, not necessarily at run time

Refresh the price catalog from models.dev with `npm run sync-models` — it prints entries
for review; the checked-in catalog stays authoritative so exports are reproducible.

## Requirements

- Node.js 18+
- [`tsx`](https://github.com/privatenumber/tsx) (installed via `npm install`, or globally)

## License

MIT
