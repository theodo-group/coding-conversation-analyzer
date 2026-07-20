# claude-conversation-analyzer

Export [Claude Code](https://claude.com/claude-code) conversations from `~/.claude/projects/`
into readable markdown, then turn them into an interactive HTML viewer for analysis.

Two standalone TypeScript tools, run with [`tsx`](https://github.com/privatenumber/tsx):

1. **`export-claude-history`** — dumps conversations to markdown, organized by git branch.
2. **`generate-html`** — converts a markdown export into a three-column interactive HTML viewer.

Both are self-contained scripts using only Node built-ins.

## Install

```bash
git clone <this-repo> claude-conversation-analyzer
cd claude-conversation-analyzer
npm install
```

Or run the scripts directly with a global `tsx` (`npm i -g tsx`).

## 1. Export conversations

```bash
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
npm run view -- <input.md> [output.html]
# or: tsx src/generate-html.ts <input.md> [output.html]
```

If `output.html` is omitted, defaults to `<input_basename>.html`.

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
