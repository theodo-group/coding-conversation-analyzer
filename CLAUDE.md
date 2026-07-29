# CLAUDE.md

Guidance for Claude Code when working in this repository. See also `AGENTS.md`
for notes on verifying visual/UI changes.

## Project

Export Claude Code conversations to markdown and render them as an interactive
HTML analyzer. Source lives in `src/`, run via `tsx` (no build step).

The unified CLI is **`cca`** (`bin/cca`), a bash dispatcher with three
subcommands:

- `cca export …` → `src/export-claude-history.ts`
- `cca generate-html …` → `src/generate-html.ts`
- `cca update` → re-runs `install.sh` to self-update (a no-op when up to date)

`cca-export` and `cca-generate-html` remain as thin backward-compat aliases.
Install/update with `install.sh`.

## Versioning

The project follows [Semantic Versioning](https://semver.org/) (`MAJOR.MINOR.PATCH`).
The current version is **1.0.0**.

**Single source of truth.** The version lives in exactly one place — the
`version` field of `package.json`. Everything else derives from it:

- `src/version.ts` reads `package.json` and exports `VERSION` plus a
  `handleVersionFlag()` helper. Import from here; never hard-code a version.
- The CLIs support `--version` / `-v`: `cca --version` → `1.0.0`; the
  subcommands report their own name, e.g. `cca export --version` → `cca-export 1.0.0`.
- Every export stamps the tool version into the sidecar marker of the generated
  markdown: `<!-- cca:data v=<data-format> tool=<version> -->`.
- `install.sh` prints the installed version after installing.

**Two distinct version numbers — do not conflate them:**

| Version | Where | Bump when |
| --- | --- | --- |
| Tool version (`VERSION`) | `package.json` | Any user-facing change, per semver below |
| Data-format version (`CCA_DATA_VERSION`) | `src/export-claude-history.ts` | Only when the embedded sidecar JSON **shape** changes incompatibly |

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
