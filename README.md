# claude-conversation-analyzer

Export [Claude Code](https://claude.com/claude-code) conversations from `~/.claude/projects/`
into readable markdown, then turn them into an interactive HTML viewer for analysis.

Two standalone TypeScript tools, run with [`tsx`](https://github.com/privatenumber/tsx):

1. **`export-claude-history`** — dumps conversations to markdown, organized by git branch.
2. **`generate-html`** — converts a markdown export into a three-column interactive HTML viewer.

Both are self-contained scripts using only Node built-ins.

## Install

### One-liner (recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/theodo-group/coding-conversation-analyzer/main/install.sh | bash
```

This clones the repo to `~/.coding-conversation-analyzer`, installs dependencies, and
puts two commands on your PATH: `cca-export` and `cca-generate-html`. Re-run the
same command any time to update.

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
cca-export <output-dir>                      # if installed via the one-liner
# or, from a clone:
npm run export -- <output-dir>
# or: tsx src/export-claude-history.ts <output-dir>
```

Exports conversations including tool results, thinking blocks, subagent conversations,
actual Edit diffs, and YAML frontmatter. Incremental — re-running only exports new or
changed conversations.

Output structure:

```
<output-dir>/
  <git-user>/
    <branch>/
      2026-03-01-12-58-08-479c0b78.md
      2026-03-01-12-58-08-479c0b78-subagents/
        agent-abc123.md
```

## 2. Generate the HTML viewer

```bash
cca-generate-html <input.md | input-dir> [output.html | output-dir]  # if installed via the one-liner
# or, from a clone:
npm run view -- <input.md | input-dir> [output.html | output-dir]
# or: tsx src/generate-html.ts <input.md | input-dir> [output.html | output-dir]
```

If the input is a single `.md` file and `output.html` is omitted, it defaults to
`<input_basename>.html`.

If the input is a **directory**, every `.md`/`.markdown` file inside is converted, writing
each `.html` next to its source — or into `output-dir` if a second argument is given.

### Viewer features

- Three-column grid layout: **Input** | **Assistant** | **Tools**
  - **Input**: your prompts (🧑); teammate/inter-agent messages (🤝, accent-colored per
    teammate with an id label, JSON payloads rendered as a key/value grid and a `summary`
    chip); local commands (⌨️, e.g. `/compact`); and subagent task notifications (🔔)
  - **Assistant**: replies (🤖) and thinking (🧠)
  - **Tools**: calls (⚪️), results (🟢), errors (🔴), and skill prompts (📜)
- Per-subtype counters in each column header (e.g. `14 🧑 · 14 🤝 · 4 ⌨️ · 3 🔔`)
- Collapsible cards with turn-based grouping
- Navigation buttons to jump between messages of the same subtype
- Tool results, errors, and skill prompts collapsed by default
- Dark theme with color-coded message types

## Requirements

- Node.js 18+
- [`tsx`](https://github.com/privatenumber/tsx) (installed via `npm install`, or globally)

## License

MIT
