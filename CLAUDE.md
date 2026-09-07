# CLAUDE.md

Guidance for Claude Code when working in this repository. See also `AGENTS.md`
for notes on verifying visual/UI changes.

## Project

Export coding-agent conversations to markdown and render them as an interactive
HTML analyzer. Source lives in `src/`, run via `tsx` (no build step).

The unified CLI is **`cca`** (`bin/cca`), a bash dispatcher with three
subcommands:

- `cca export …` → `src/export-history.ts`
- `cca generate-html …` → `src/generate-html.ts`
- `cca update` → re-runs `install.sh` to self-update (a no-op when up to date)

`cca-export` and `cca-generate-html` remain as thin backward-compat aliases, as
does `src/export-claude-history.ts` (it just imports `export-history.ts`).
Install/update with `install.sh`.

## Sources

The exporter is source-agnostic. `src/sources/` holds one adapter per coding
agent, each turning what that agent stores on disk into the neutral intermediate
in `sources/types.ts`; `export-history.ts` renders markdown and builds the
dashboard sidecar from that intermediate and knows nothing about any of their
on-disk formats.

- `sources/claude.ts` — Claude Code's jsonl transcripts under `~/.claude/projects/`
- `sources/opencode.ts` — OpenCode's SQLite database, read-only via `node:sqlite`
- `sources/cursor.ts` — Cursor's `state.vscdb`, same
- `sources/sqlite.ts` — the shared read-only open (WAL replay, muted experimental
  warning) both SQLite adapters use

Adding a source means writing an adapter, not touching the exporter. Anything
source-specific — tool names, input key casing, how a human turn is told apart
from an injected one, whether a call and its result are one record or two —
belongs in the adapter, which normalises onto the
canonical tool names (`Read`, `Edit`, `Bash`, `Agent`, …) and snake_case input
keys (`file_path`, `old_string`, …) the shared code formats against.

**Regression rule:** a change to the shared exporter must keep Claude Code
output byte-identical. Verify by exporting a frozen `~/.claude` copy before and
after (`cca export <dir> --claude-dir <frozen> --source claude`) and diffing.
Only the `tool=` stamp in the sidecar marker may differ, and only across a
version bump. Each SQLite source has the same escape hatch for a frozen
fixture: `--opencode-dir`, `--cursor-dir`.

`docs/opencode-export-spec.md` and `docs/cursor-export-spec.md` record each
source's data model and the design decisions behind its adapter.

**A source that records no token usage.** Cursor writes zeros for every
`tokenCount`; it meters usage server-side. Such a source sets
`NeutralSession.usageAvailable = false`, which reaches the sidecar and makes the
reports omit cost rather than render `$0.00` — a zero is a claim about the
session, and the wrong one. The wording of that notice lives in exactly one
place, `src/no-usage.ts`, and appears on five surfaces: the markdown
frontmatter (`tokens: unavailable`), the markdown body, the dashboard (banner +
`n/a` tile + context-breakdown panel in place of the cost chart), the discussion
viewer, and the index (`n/a`, excluded from the selected total). The simulation
page is not generated at all, since it is built entirely on usage. If you add a
source with the same gap, set the flag and the five surfaces follow.

## Pricing

`src/models.ts` is the single price/limit catalog, using models.dev field names
verbatim (`limit.{context,output}`, `cost.{input,output,cache_read,cache_write}`)
— the same shape OpenCode ships at `~/.cache/opencode/models.json`, so entries
copy across in either direction. Never derive cache prices from the input price;
the ratio does not hold for every model. `npm run sync-models` prints a refreshed
catalog literal for review, but the checked-in catalog stays authoritative so
exports are reproducible without OpenCode installed.

Models from providers the catalog doesn't know are embedded per export in the
sidecar's `models` field and merged in at render time via `withCatalog()`.

## Versioning

The project follows [Semantic Versioning](https://semver.org/) (`MAJOR.MINOR.PATCH`).
The current version is **1.3.0**.

**Single source of truth.** The version lives in exactly one place — the
`version` field of `package.json`. Everything else derives from it:

- `src/version.ts` reads `package.json` and exports `VERSION` plus a
  `handleVersionFlag()` helper. Import from here; never hard-code a version.
- The CLIs support `--version` / `-v`: `cca --version` → `1.3.0`; the
  subcommands report their own name, e.g. `cca export --version` → `cca-export 1.3.0`.
- Every export stamps the tool version into the sidecar marker of the generated
  markdown: `<!-- cca:data v=<data-format> tool=<version> -->`.
- `install.sh` prints the installed version after installing.

**Two distinct version numbers — do not conflate them:**

| Version | Where | Bump when |
| --- | --- | --- |
| Tool version (`VERSION`) | `package.json` | Any user-facing change, per semver below |
| Data-format version (`CCA_DATA_VERSION`) | `src/export-history.ts` | Only when the embedded sidecar JSON **shape** changes incompatibly |

The `version` field inside the sidecar JSON is unrelated — it is the Claude Code
version that produced the source conversation.

**When to bump the tool version:**

- **PATCH** (`1.0.x`) — bug fixes, no change to output shape or CLI surface.
- **MINOR** (`1.x.0`) — new flags, new metrics, additive output changes that
  older readers still parse.
- **MAJOR** (`x.0.0`) — breaking CLI changes or an incompatible export format
  (usually paired with a `CCA_DATA_VERSION` bump).

**Cutting a release:**

1. Update `version` in `package.json`.
2. Verify: `cca-export --version` and `cca-generate-html --version` report it.
3. Commit, then tag: `git tag -a vX.Y.Z -m "vX.Y.Z"` and `git push --tags`.
   Installing a tag: `BRANCH=vX.Y.Z bash install.sh`.
