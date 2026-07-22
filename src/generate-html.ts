#!/usr/bin/env tsx
// generate-html v2.1 – Convert Claude Code conversation markdown exports to interactive HTML

import * as fs from "fs";
import * as path from "path";
import { generateDashboardHtml, summarizeSidecar } from "./generate-dashboard.ts";
import { generateIndexHtml, type IndexEntry } from "./generate-index.ts";

// --- Types ---

interface Frontmatter {
  raw?: string;
}

type Column = "input" | "assistant" | "tool";
type Subtype =
  | "user"
  | "teammate"
  | "command"
  | "notification"
  | "assistant"
  | "thinking"
  | "tool-call"
  | "tool-result"
  | "tool-error"
  | "skill-prompt";

interface RawBlock {
  heading: string;
  lines: string[];
  isMeta: boolean;
}

interface ContentBlock {
  heading: string;
  lines: string[];
  column: Column;
  subtype: Subtype;
  teammateId?: string;
  teammateColor?: string;
}

interface GridItem {
  row: number;
  col: number;
  card: string;
  turn: number;
}

// Display metadata per subtype. Column order also drives the grid layout.
const SUBTYPE_META: Record<Subtype, { column: Column; emoji: string; label: string }> = {
  user: { column: "input", emoji: "🧑", label: "User" },
  teammate: { column: "input", emoji: "🤝", label: "Teammate" },
  command: { column: "input", emoji: "⌨️", label: "Command" },
  notification: { column: "input", emoji: "🔔", label: "Notification" },
  assistant: { column: "assistant", emoji: "🤖", label: "Assistant" },
  thinking: { column: "assistant", emoji: "🧠", label: "Thinking" },
  "tool-call": { column: "tool", emoji: "⚪️", label: "Tool Call" },
  "tool-result": { column: "tool", emoji: "🟢", label: "Result" },
  "tool-error": { column: "tool", emoji: "🔴", label: "Error" },
  "skill-prompt": { column: "tool", emoji: "📜", label: "Skill Prompt" },
};

const COLUMN_INDEX: Record<Column, number> = { input: 1, assistant: 2, tool: 3 };
const COLUMN_SUBTYPES: Record<Column, Subtype[]> = {
  input: ["user", "teammate", "command", "notification"],
  assistant: ["assistant", "thinking"],
  tool: ["tool-call", "tool-result", "tool-error", "skill-prompt"],
};

// Maps a Claude Code teammate `color` name to a hex usable on the dark theme.
// Unknown names fall back to the raw value (CSS accepts named colors).
const TEAMMATE_COLORS: Record<string, string> = {
  blue: "#58a6ff",
  green: "#3fb950",
  teal: "#39c5cf",
  cyan: "#56d4dd",
  red: "#ff7b72",
  orange: "#ffa657",
  yellow: "#d29922",
  magenta: "#bc8cff",
  purple: "#bc8cff",
  pink: "#f778ba",
  gray: "#8b949e",
  grey: "#8b949e",
  white: "#e6edf3",
};

function teammateAccent(color: string | undefined): string {
  if (!color) return "#bc8cff";
  return TEAMMATE_COLORS[color.toLowerCase()] ?? color;
}

// --- Embedded metadata ---

// The exporter appends the dashboard sidecar to the .md as a trailing hidden
// HTML comment (`<!-- cca:data v=1\n{…}\n-->`), making the .md self-contained
// for both the discussion and dashboard views. This matches that block so it
// can be both stripped before parsing the conversation and parsed for metrics.
const DATA_BLOCK_RE = /\n*<!-- cca:data v=\d+\n([\s\S]*?)\n-->\s*$/;

// Remove the trailing embedded data block so it never leaks into the parsed
// conversation body.
function stripDataBlock(text: string): string {
  return text.replace(DATA_BLOCK_RE, "");
}

// Parse the embedded sidecar out of raw .md text, or null when absent/invalid.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractEmbeddedSidecar(text: string): any {
  const m = text.match(DATA_BLOCK_RE);
  if (!m?.[1]) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

// --- Parsing ---

const BLOCK_HEADING_RE = /^## ((?:🧑|🤖|⚪️|🟢|🔴|❌|🤝|⌨️|🔔|🧠|📜)\s.+)$/;

function parseFrontmatter(lines: string[]): { fm: Frontmatter; rest: string[] } {
  if (!lines.length || lines[0]!.trim() !== "---") return { fm: {}, rest: lines };
  let end: number | null = null;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]!.trim() === "---") {
      end = i;
      break;
    }
  }
  if (end === null) return { fm: {}, rest: lines };
  const raw = lines.slice(1, end).join("\n");
  return { fm: { raw }, rest: lines.slice(end + 1) };
}

function classify(heading: string): Pick<ContentBlock, "column" | "subtype" | "teammateId" | "teammateColor"> {
  if (heading.includes("🤝") || heading.includes("Teammate")) {
    const m = heading.match(/Teammate:\s*([^()]+?)(?:\s*\(([^)]+)\))?\s*$/);
    const id = m?.[1]?.trim();
    const color = m?.[2]?.trim();
    const res: Pick<ContentBlock, "column" | "subtype" | "teammateId" | "teammateColor"> = {
      column: "input",
      subtype: "teammate",
    };
    if (id) res.teammateId = id;
    if (color) res.teammateColor = color;
    return res;
  }
  if (heading.includes("⌨️") || heading.includes("Command")) return { column: "input", subtype: "command" };
  if (heading.includes("🔔") || heading.includes("Task Notification")) return { column: "input", subtype: "notification" };
  if (heading.includes("🧠") || heading.includes("Thinking")) return { column: "assistant", subtype: "thinking" };
  if (heading.includes("📜") || heading.includes("Skill Prompt")) return { column: "tool", subtype: "skill-prompt" };
  if (heading.includes("🧑") && heading.includes("User")) return { column: "input", subtype: "user" };
  if (heading.includes("🤖") && heading.includes("Assistant")) return { column: "assistant", subtype: "assistant" };
  if (heading.includes("⚪️") || heading.includes("Tool Call")) return { column: "tool", subtype: "tool-call" };
  if (heading.includes("🟢") || heading.includes("Tool Result")) return { column: "tool", subtype: "tool-result" };
  if (heading.includes("🔴") || heading.includes("Tool Error")) return { column: "tool", subtype: "tool-error" };
  if (heading.includes("❌") || heading.includes("Tool Rejected")) return { column: "tool", subtype: "tool-error" };
  return { column: "assistant", subtype: "assistant" };
}

function parseBlocks(lines: string[]): RawBlock[] {
  const blocks: RawBlock[] = [];
  let current: RawBlock | null = null;
  let seenBlock = false;

  for (const line of lines) {
    const m = line.match(BLOCK_HEADING_RE);
    if (m) {
      if (current) blocks.push(current);
      current = { heading: m[1]!.trim(), lines: [], isMeta: false };
      seenBlock = true;
      continue;
    }
    if (!seenBlock) {
      const h1 = line.match(/^# (.+)$/);
      if (h1) {
        if (current) blocks.push(current);
        current = { heading: h1[1]!.trim(), lines: [], isMeta: true };
        continue;
      }
    }
    if (current) current.lines.push(line);
  }
  if (current) blocks.push(current);
  return blocks;
}

// --- HTML Generation ---

function escape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function contentToHtml(lines: string[]): string {
  const text = lines.join("\n").trim();
  if (!text) return '<p class="empty">(empty)</p>';

  const parts: string[] = [];
  let inCode = false;
  let codeLang = "";
  let codeLines: string[] = [];

  for (const line of lines) {
    if (!inCode && /^```/.test(line)) {
      inCode = true;
      codeLang = line.slice(3).trim();
      codeLines = [];
      continue;
    }
    if (inCode && line.trim() === "```") {
      inCode = false;
      const langAttr = codeLang ? ` class="language-${escape(codeLang)}"` : "";
      parts.push(`<pre><code${langAttr}>${escape(codeLines.join("\n"))}</code></pre>`);
      continue;
    }
    if (inCode) {
      codeLines.push(line);
      continue;
    }

    if (line.trim() === "") {
      parts.push("");
    } else if (/^### /.test(line)) {
      parts.push(`<h4>${escape(line.slice(4))}</h4>`);
    } else if (/^## /.test(line)) {
      parts.push(`<h3>${escape(line.slice(3))}</h3>`);
    } else if (line.startsWith("|") && line.indexOf("|", 1) !== -1) {
      const cells = line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const isSeparator = cells.every((c) => /^[-:]+$/.test(c));
      if (parts.length && parts[parts.length - 1]!.endsWith("</table>")) {
        const prev = parts[parts.length - 1]!.slice(0, -"</table>".length);
        if (isSeparator) {
          parts[parts.length - 1] = prev + "</table>";
        } else {
          const row = cells.map((c) => `<td>${escape(c)}</td>`).join("");
          parts[parts.length - 1] = prev + `<tr>${row}</tr></table>`;
        }
      } else if (!isSeparator) {
        const row = cells.map((c) => `<th>${escape(c)}</th>`).join("");
        parts.push(`<table><tr>${row}</tr></table>`);
      }
    } else if (line.startsWith("- ") || line.startsWith("* ")) {
      parts.push(`<div class='list-item'>${escape(line)}</div>`);
    } else if (/^\d+\. /.test(line)) {
      parts.push(`<div class='list-item'>${escape(line)}</div>`);
    } else {
      let processed = escape(line).replace(/`([^`]+)`/g, "<code>$1</code>");
      processed = processed.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
      parts.push(`<p>${processed}</p>`);
    }
  }

  if (inCode) {
    parts.push(`<pre><code>${escape(codeLines.join("\n"))}</code></pre>`);
  }

  return parts.join("\n");
}

function tryParseJsonObject(s: string): Record<string, unknown> | null {
  const t = s.trim();
  if (!t.startsWith("{") || !t.endsWith("}")) return null;
  try {
    const o: unknown = JSON.parse(t);
    return o !== null && typeof o === "object" && !Array.isArray(o)
      ? (o as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function kvGrid(obj: Record<string, unknown>): string {
  const rows = Object.entries(obj)
    .map(([k, v]) => {
      const val = typeof v === "string" ? v : JSON.stringify(v);
      return `<div class="kv-key">${escape(k)}</div><div class="kv-val">${escape(val)}</div>`;
    })
    .join("");
  return `<div class="kv-grid">${rows}</div>`;
}

// Teammate bodies are pre-cleaned by the exporter (no XML wrapper / boilerplate).
// Surface the optional summary as a chip, and render a JSON payload as a
// key/value grid rather than a raw blob.
function renderTeammateBody(lines: string[]): string {
  const bodyLines = [...lines];
  let summary = "";
  const sIdx = bodyLines.findIndex((l) => l.trim().startsWith("**Summary:**"));
  if (sIdx !== -1) {
    summary = bodyLines[sIdx]!.replace(/\*\*Summary:\*\*\s*/, "").trim();
    bodyLines.splice(sIdx, 1);
  }
  const rest = bodyLines.join("\n").trim();
  const obj = tryParseJsonObject(rest);
  const payload = obj ? kvGrid(obj) : contentToHtml(bodyLines);
  const summaryHtml = summary ? `<div class="tm-summary">${escape(summary)}</div>` : "";
  return summaryHtml + payload;
}

interface CardOpts {
  id: string;
  column: Column;
  subtype: Subtype;
  idx: number;
  total: number;
  label: string;
  icon: string;
  bodyHtml: string;
  prevId: string;
  nextId: string;
  collapsed: boolean;
  accentStyle: string;
  titleColor: string;
  navLabel: string;
  linkHtml?: string;
}

function buildCardHtml(o: CardOpts): string {
  const prevDisabled = o.prevId ? "" : " disabled";
  const nextDisabled = o.nextId ? "" : " disabled";
  const collapsed = o.collapsed ? " collapsed" : "";
  const style = o.accentStyle ? ` style="${o.accentStyle}"` : "";
  const swatch = o.titleColor ? `<span class="swatch" style="background:${o.titleColor}"></span>` : "";
  const titleStyle = o.titleColor ? ` style="color:${o.titleColor}"` : "";
  return `<div class="card${collapsed}" id="${o.id}" data-col="${o.column}" data-subtype="${o.subtype}"${style}>
  <div class="card-header" onclick="toggleCard(this)">
    <span class="card-icon">${o.icon}</span>
    ${swatch}<span class="card-title"${titleStyle}>${escape(o.label)}</span>
    ${o.linkHtml || ""}
    <span class="card-badge">#${o.idx + 1}/${o.total}</span>
    <span class="card-toggle">▼</span>
  </div>
  <div class="card-body">${o.bodyHtml}</div>
  <div class="card-nav">
    <button class="nav-btn" onclick="event.stopPropagation(); jumpTo('${o.prevId}')"${prevDisabled}>↑ Prev ${o.navLabel}</button>
    <button class="nav-btn" onclick="event.stopPropagation(); jumpTo('${o.nextId}')"${nextDisabled}>↓ Next ${o.navLabel}</button>
  </div>
</div>`;
}

// Map each spawned agentId → the href of its exported discussion page, relative
// to `mdPath`. The exporter drops subagent/workflow transcripts into sibling
// `<base>-subagents/` and `<base>-workflows/` dirs, each file named
// `<agentTs>-<agentId>.md`; the output tree mirrors the source, so the
// source-relative path (with `-discussion.html` swapped in) doubles as the href.
// Used to turn `[[agent:<id>]]` markers in a spawn block into inline links.
function buildAgentHrefMap(mdPath: string): Map<string, string> {
  const map = new Map<string, string>();
  const dir = path.dirname(mdPath);
  const base = path.basename(mdPath).replace(/\.[^.]+$/, "");
  const walk = (d: string): void => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        walk(full);
      } else if (/\.(md|markdown)$/i.test(e.name)) {
        // Strip the leading export timestamp (`YYYY-MM-DD-HH-MM-SS-`) to recover
        // the agentId that names the rest of the file.
        const m = e.name.replace(/\.[^.]+$/, "").match(/^\d{4}(?:-\d{2}){5}-(.+)$/);
        if (!m) continue;
        const href = path
          .relative(dir, full)
          .split(path.sep)
          .join("/")
          .replace(/\.[^.]+$/, "-discussion.html");
        map.set(m[1]!, href);
      }
    }
  };
  walk(path.join(dir, `${base}-subagents`));
  walk(path.join(dir, `${base}-workflows`));
  return map;
}

function generateHtml(mdPath: string): string {
  const text = stripDataBlock(fs.readFileSync(mdPath, "utf-8"));
  const allLines = text.split("\n");
  const agentHrefs = buildAgentHrefMap(mdPath);

  const { fm: frontmatter, rest } = parseFrontmatter(allLines);
  const rawBlocks = parseBlocks(rest);

  const items: ContentBlock[] = rawBlocks
    .filter((b) => !b.isMeta)
    .map((b) => ({ heading: b.heading, lines: b.lines, ...classify(b.heading) }));

  const totals: Partial<Record<Subtype, number>> = {};
  for (const b of items) totals[b.subtype] = (totals[b.subtype] ?? 0) + 1;

  const counters: Partial<Record<Subtype, number>> = {};
  const gridItems: GridItem[] = [];
  const turnHeaderRow: Record<number, number> = {};
  let currentRow = 1;
  let lastColInRow = 0;
  let turnI = 0;

  for (const b of items) {
    const gc = COLUMN_INDEX[b.column];

    if (b.column === "input") {
      // The leftmost (input) column opens a new conversation turn. Reserve a
      // full-width row for the turn's clickable separator, then place the
      // turn's content on the row below so the two never overlap.
      turnI++;
      currentRow++;
      turnHeaderRow[turnI] = currentRow;
      currentRow++;
      lastColInRow = 0;
    } else if (gc <= lastColInRow) {
      currentRow++;
      lastColInRow = 0;
    }

    const idx = counters[b.subtype] ?? 0;
    counters[b.subtype] = idx + 1;
    const total = totals[b.subtype] ?? 1;

    const meta = SUBTYPE_META[b.subtype];
    const isTeammate = b.subtype === "teammate";
    const accent = isTeammate ? teammateAccent(b.teammateColor) : "";
    const label = isTeammate
      ? b.teammateId ?? "Teammate"
      : b.heading.replace(/^(🧑|🤖|⚪️|🟢|🔴|❌|🤝|⌨️|🔔|🧠|📜)\s*/, "");
    const icon = meta.emoji;
    const accentStyle = isTeammate ? `border-left-color:${accent}` : "";

    // Agent/Task spawn blocks carry `[[agent:<id>]]` markers (added by the
    // exporter). Pull them out of the body and turn resolvable ones into a
    // header link into the subagent's own discussion page.
    let bodyLines = b.lines;
    let linkHtml = "";
    if (b.subtype === "tool-call") {
      const ids: string[] = [];
      bodyLines = b.lines.filter((l) => {
        const m = l.trim().match(/^\[\[agent:([^\]]+)\]\]$/);
        if (m) {
          ids.push(m[1]!);
          return false;
        }
        return true;
      });
      linkHtml = ids
        .map((id) => agentHrefs.get(id))
        .filter((href): href is string => !!href)
        .map((href) => `<a class="agent-link" href="${escape(href)}" onclick="event.stopPropagation()" title="Open this subagent's transcript">↗ agent</a>`)
        .join("");
    }

    const bodyHtml = isTeammate ? renderTeammateBody(b.lines) : contentToHtml(bodyLines);
    const nextId = idx + 1 < total ? `${b.subtype}-${idx + 1}` : "";
    const prevId = idx > 0 ? `${b.subtype}-${idx - 1}` : "";
    const collapsed =
      b.subtype === "tool-result" || b.subtype === "tool-error" || b.subtype === "skill-prompt";

    const card = buildCardHtml({
      id: `${b.subtype}-${idx}`,
      column: b.column,
      subtype: b.subtype,
      idx,
      total,
      label,
      icon,
      bodyHtml,
      prevId,
      nextId,
      collapsed,
      accentStyle,
      titleColor: isTeammate ? accent : "",
      navLabel: meta.label,
      linkHtml,
    });
    gridItems.push({ row: currentRow, col: gc, card, turn: turnI });
    lastColInRow = gc;
  }

  const itemsHtml: string[] = [];
  const seenTurns = new Set<number>();
  for (const { row, col: gc, card, turn } of gridItems) {
    const turnClass = turn % 2 === 0 ? "even" : "odd";
    itemsHtml.push(
      `<div class="grid-item ${turnClass}" data-turn="${turn}" style="grid-row:${row}; grid-column:${gc};">${card}</div>`,
    );

    if (!seenTurns.has(turn)) {
      seenTurns.add(turn);
      const hr = turnHeaderRow[turn];
      if (hr) {
        itemsHtml.push(
          `<div class="turn-separator" data-turn="${turn}" onclick="toggleTurn(${turn})" ` +
          `title="Collapse/expand this turn" style="grid-row:${hr}; grid-column: 1 / 4;">` +
          `<span class="turn-toggle">▼</span><span class="turn-label">Turn ${turn}</span></div>`,
        );
      }
    }
  }

  const columnCounter = (col: Column): string =>
    COLUMN_SUBTYPES[col]
      .filter((st) => (totals[st] ?? 0) > 0)
      .map((st) => `${totals[st]} ${SUBTYPE_META[st].emoji}`)
      .join(" · ");

  // `messages`/`tools` counts are intentionally dropped here — they duplicate
  // the per-column counters in the column headers below.
  const FM_LABELS: Record<string, string> = {
    branch: "Branch",
    started: "Started",
    ended: "Ended",
    duration: "Duration",
    uuid: "Session",
  };
  const FM_ORDER = ["branch", "started", "ended", "duration", "uuid"];
  let fmHtml = "";
  if (frontmatter.raw) {
    const map: Record<string, string> = {};
    for (const line of frontmatter.raw.split("\n")) {
      const i = line.indexOf(":");
      if (i === -1) continue;
      map[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    fmHtml = FM_ORDER.filter((k) => map[k])
      .map((k) => {
        const v = k === "uuid" ? map[k]!.slice(0, 8) : map[k]!;
        return `<span class="meta-field"><span class="mk">${escape(FM_LABELS[k]!)}</span><span class="mv">${escape(v)}</span></span>`;
      })
      .join("");
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Claude Conversation Viewer</title>
<style>
:root {
  --bg: #0d1117;
  --surface: #161b22;
  --border: #30363d;
  --text: #e6edf3;
  --text-muted: #8b949e;
  --user-accent: #3fb950;
  --teammate-accent: #bc8cff;
  --command-accent: #768390;
  --notif-accent: #56d4dd;
  --assistant-accent: #58a6ff;
  --thinking-accent: #8957e5;
  --tool-accent: #d29922;
  --tool-result: #238636;
  --tool-error: #da3633;
  --skill-accent: #ffa657;
  --hover: #1c2128;
  --turn-even: rgba(255,255,255,0.02);
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
  background: var(--bg); color: var(--text); line-height: 1.5;
}

/* App header — topbar + column headers stick together as one block, so
   there is no magic offset to keep in sync between the two. */
.app-header {
  position: sticky; top: 0; z-index: 100;
  background: var(--surface); border-bottom: 1px solid var(--border);
}

/* Top bar (info header) */
.topbar {
  padding: 8px 16px; display: flex; align-items: center;
  gap: 8px 16px; flex-wrap: wrap;
  transition: padding 0.2s ease;
}
.topbar h1 { font-size: 14px; font-weight: 600; white-space: nowrap; }
.topbar .controls { display: flex; gap: 6px; margin-left: auto; flex-wrap: wrap; }
.topbar button {
  background: var(--bg); border: 1px solid var(--border);
  color: var(--text); padding: 4px 10px; border-radius: 6px;
  cursor: pointer; font-size: 11px;
}
.topbar button:hover { background: var(--hover); }

/* Structured metadata — own row of labelled fields, collapses on scroll. */
.meta {
  flex-basis: 100%; display: flex; flex-wrap: wrap; gap: 4px 18px;
  overflow: hidden; max-height: 40px;
  transition: max-height 0.25s ease, opacity 0.2s ease, margin 0.2s ease;
}
.meta:empty { display: none; }
.meta-field { display: inline-flex; align-items: baseline; gap: 6px; }
.meta-field .mk {
  color: var(--text-muted); font-size: 9px; font-weight: 600;
  text-transform: uppercase; letter-spacing: 0.04em;
}
.meta-field .mv { color: var(--text); font-family: monospace; font-size: 11px; }

/* Condensed state — applied while scrolled. The meta row folds away so the
   column headers stay close to the content; title + controls remain. */
.app-header.condensed .topbar { padding-top: 4px; padding-bottom: 4px; }
.app-header.condensed .meta { max-height: 0; opacity: 0; margin: 0; }

/* Column headers — also act as the per-column collapse toggles, so the
   topbar no longer needs separate per-column buttons. */
.col-headers {
  display: grid; grid-template-columns: 1fr 1fr 1fr;
  border-top: 1px solid var(--border);
}
.col-hdr {
  padding: 6px 16px; font-weight: 600; font-size: 13px;
  border-right: 1px solid var(--border);
  cursor: pointer; user-select: none;
  display: flex; align-items: center; gap: 6px;
}
.col-hdr:last-child { border-right: none; }
.col-hdr:hover { background: var(--hover); }
.col-hdr .ct { font-size: 11px; color: var(--text-muted); font-weight: 500; margin-left: auto; }
.col-hdr.ch-input { color: var(--user-accent); border-bottom: 2px solid var(--user-accent); }
.col-hdr.ch-assistant { color: var(--assistant-accent); border-bottom: 2px solid var(--assistant-accent); }
.col-hdr.ch-tool { color: var(--tool-accent); border-bottom: 2px solid var(--tool-accent); }

/* The conversation grid */
.conversation {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  grid-auto-rows: auto;
  gap: 0;
  padding: 0;
}

/* Grid items */
.grid-item {
  padding: 4px 8px;
  z-index: 2;
  min-width: 0;
  overflow: hidden;
}
.grid-item.even { background: var(--turn-even); }
/* When a turn is collapsed via its separator, its cards are removed from the
   grid entirely so the rows collapse to nothing — only the bar remains. */
.grid-item.turn-hidden { display: none; }

/* Turn separator — its own full-width row (never overlaps a card), and a
   click target that collapses/expands every card in the turn. */
.turn-separator {
  display: flex; align-items: center; gap: 6px;
  padding: 3px 10px;
  border-top: 1px solid var(--border);
  cursor: pointer; user-select: none;
}
.turn-separator:hover { background: var(--hover); }
.turn-toggle {
  font-size: 9px; color: var(--text-muted);
  transition: transform 0.15s;
}
.turn-separator.collapsed .turn-toggle { transform: rotate(-90deg); }
.turn-label {
  font-size: 10px; font-weight: 600; color: var(--text-muted);
  letter-spacing: 0.03em;
}

/* Cards */
.card {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: 8px; overflow: hidden;
  transition: border-color 0.2s, box-shadow 0.2s;
}
.card.highlight {
  border-color: #58a6ff !important;
  box-shadow: 0 0 12px rgba(88,166,255,0.4);
}
.card[data-subtype="user"] { border-left: 3px solid var(--user-accent); }
.card[data-subtype="teammate"] { border-left: 3px solid var(--teammate-accent); }
.card[data-subtype="command"] { border-left: 3px solid var(--command-accent); }
.card[data-subtype="notification"] { border-left: 3px solid var(--notif-accent); }
.card[data-subtype="assistant"] { border-left: 3px solid var(--assistant-accent); }
.card[data-subtype="thinking"] { border-left: 3px solid var(--thinking-accent); }
.card[data-subtype="tool-call"] { border-left: 3px solid var(--tool-accent); }
.card[data-subtype="tool-result"] { border-left: 3px solid var(--tool-result); }
.card[data-subtype="tool-error"] { border-left: 3px solid var(--tool-error); }
.card[data-subtype="skill-prompt"] { border-left: 3px solid var(--skill-accent); }

/* Teammate cards get a dashed accent + tinted title so inter-agent
   messages read differently from the human's own input. */
.card[data-subtype="teammate"] { border-left-style: dashed; }
.card[data-subtype="teammate"] .card-title { color: var(--teammate-accent); font-style: italic; }
/* Thinking is the assistant's own reasoning — italic + tinted so it's
   distinct from its spoken replies in the same column. */
.card[data-subtype="thinking"] .card-title { color: var(--thinking-accent); font-style: italic; }
.card[data-subtype="command"] .card-title { color: var(--command-accent); font-family: monospace; }

/* Small color dot rendered before a teammate's id in the card header. */
.swatch {
  width: 8px; height: 8px; border-radius: 50%;
  display: inline-block; flex-shrink: 0;
}
/* Teammate summary attribute, shown as a lead-in chip above the payload. */
.tm-summary {
  font-style: italic; color: var(--text);
  background: var(--bg); border-left: 2px solid var(--teammate-accent);
  padding: 4px 8px; margin-bottom: 8px; border-radius: 4px; font-size: 12px;
}
/* JSON teammate payloads render as a key/value grid instead of a raw blob. */
.kv-grid { display: grid; grid-template-columns: max-content 1fr; gap: 3px 12px; font-size: 12px; }
.kv-key { color: var(--text-muted); font-family: monospace; }
.kv-val { word-break: break-word; }

.card-header {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 10px; cursor: pointer; user-select: none;
}
.card-header:hover { background: var(--hover); }
.card-icon { font-size: 13px; flex-shrink: 0; }
.card-title {
  flex: 1; font-size: 12px; font-weight: 600;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.card-badge {
  font-size: 9px; color: var(--text-muted);
  background: var(--bg); padding: 1px 5px; border-radius: 10px; flex-shrink: 0;
}
.agent-link {
  font-size: 9px; font-weight: 600; text-decoration: none; flex-shrink: 0;
  color: var(--tool-accent); background: var(--bg);
  border: 1px solid var(--tool-accent); border-radius: 10px; padding: 1px 6px;
}
.agent-link:hover { background: var(--tool-accent); color: var(--bg); }
.card-toggle {
  font-size: 9px; color: var(--text-muted);
  transition: transform 0.15s; flex-shrink: 0;
}
.card.collapsed .card-toggle { transform: rotate(-90deg); }
.card.collapsed .card-body { display: none; }
.card.collapsed .card-nav { display: none; }

.card-body {
  padding: 8px 10px; font-size: 13px;
  max-height: 500px; overflow-y: auto;
  border-top: 1px solid var(--border);
}
.card-body p { margin: 3px 0; }
.card-body h3 { margin: 8px 0 4px; font-size: 14px; }
.card-body h4 { margin: 6px 0 3px; font-size: 13px; color: var(--text-muted); }
.card-body pre {
  background: var(--bg); border: 1px solid var(--border);
  border-radius: 6px; padding: 8px; overflow-x: auto;
  font-size: 11px; margin: 6px 0;
}
.card-body code { background: var(--bg); padding: 1px 4px; border-radius: 3px; font-size: 12px; }
.card-body pre code { background: none; padding: 0; }
.card-body table { border-collapse: collapse; width: 100%; margin: 6px 0; font-size: 12px; }
.card-body th, .card-body td { border: 1px solid var(--border); padding: 4px 8px; text-align: left; }
.card-body th { background: var(--bg); }
.card-body .list-item { padding: 2px 0 2px 12px; font-size: 13px; }
.card-body .empty { color: var(--text-muted); font-style: italic; }
.card-body strong { color: #f0f6fc; }

.card-nav {
  display: flex; gap: 4px; padding: 4px 10px;
  border-top: 1px solid var(--border);
}
.nav-btn {
  flex: 1; background: var(--bg); border: 1px solid var(--border);
  color: var(--text-muted); padding: 3px 6px; border-radius: 4px;
  cursor: pointer; font-size: 10px; text-align: center;
}
.nav-btn:hover:not(:disabled) { background: var(--hover); color: var(--text); }
.nav-btn:disabled { opacity: 0.3; cursor: default; }

::-webkit-scrollbar { width: 6px; }
::-webkit-scrollbar-track { background: var(--bg); }
::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
</style>
</head>
<body>

<header class="app-header" id="appHeader">
  <div class="topbar">
    <h1>Claude Conversation Viewer</h1>
    <div class="controls">
      <button onclick="collapseAll()">Collapse All</button>
      <button onclick="expandAll()">Expand All</button>
      <button onclick="toggleToolResults()">Toggle Tool Results</button>
    </div>
    <div class="meta">${fmHtml}</div>
  </div>
  <div class="col-headers">
    <div class="col-hdr ch-input" onclick="toggleColumn('input')" title="Click to collapse/expand this column">🧑 Input <span class="ct">${columnCounter("input")}</span></div>
    <div class="col-hdr ch-assistant" onclick="toggleColumn('assistant')" title="Click to collapse/expand this column">🤖 Assistant <span class="ct">${columnCounter("assistant")}</span></div>
    <div class="col-hdr ch-tool" onclick="toggleColumn('tool')" title="Click to collapse/expand this column">🔧 Tools <span class="ct">${columnCounter("tool")}</span></div>
  </div>
</header>

<div class="conversation">
  ${itemsHtml.join("")}
</div>

<script>
function toggleCard(header) {
  header.closest('.card').classList.toggle('collapsed');
}
function jumpTo(id) {
  if (!id) return;
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.remove('collapsed');
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.add('highlight');
  setTimeout(() => el.classList.remove('highlight'), 1500);
}
function collapseAll() {
  document.querySelectorAll('.card').forEach(c => c.classList.add('collapsed'));
}
function expandAll() {
  document.querySelectorAll('.card').forEach(c => c.classList.remove('collapsed'));
}
function toggleColumn(col) {
  document.querySelectorAll('.card[data-col="' + col + '"]').forEach(c => c.classList.toggle('collapsed'));
}
function toggleToolResults() {
  document.querySelectorAll('.card[data-subtype="tool-result"], .card[data-subtype="tool-error"]').forEach(c => c.classList.toggle('collapsed'));
}
function toggleTurn(n) {
  const sep = document.querySelector('.turn-separator[data-turn="' + n + '"]');
  const collapse = sep ? !sep.classList.contains('collapsed') : true;
  if (sep) sep.classList.toggle('collapsed', collapse);
  document.querySelectorAll('.grid-item[data-turn="' + n + '"]').forEach(el => el.classList.toggle('turn-hidden', collapse));
}
// Fold the info-header metadata away once the user scrolls past it, keeping
// the column headers tight against the content.
(function () {
  const header = document.getElementById('appHeader');
  let condensed = false;
  window.addEventListener('scroll', function () {
    const next = window.scrollY > 40;
    if (next !== condensed) {
      condensed = next;
      header.classList.toggle('condensed', condensed);
    }
  }, { passive: true });
})();
</script>
</body>
</html>`;
}

// --- Main ---

interface FileResult {
  discussionPath: string;
  dashboardPath: string | null;
  title: string;
  metrics: ReturnType<typeof summarizeSidecar> | null;
}

// First `# ` heading in the markdown, used as an index title when no sidecar
// (which carries its own `title`) is present. Falls back to the file's name.
function titleFromMarkdown(mdPath: string): string {
  try {
    const text = fs.readFileSync(mdPath, "utf-8");
    for (const line of text.split("\n")) {
      const m = line.match(/^# (.+)$/);
      if (m) return m[1]!.trim();
    }
  } catch {
    /* fall through to filename */
  }
  return path.basename(mdPath).replace(/\.[^.]+$/, "");
}

// Renders the discussion viewer to `<base>-discussion.html`, and — when a
// sidecar `<name>.json` sits next to the source markdown (written by
// cca-export) — also renders the dashboard report to `<base>-dashboard.html`.
// `outputPath` is the base `.html` path; the two suffixes are derived from it.
// Returns the paths, title and headline metrics so the caller can build an
// index across many conversions.
function convertFile(inputPath: string, outputPath: string): FileResult {
  const discussionPath = outputPath.replace(/\.html$/i, "-discussion.html");
  const htmlContent = generateHtml(inputPath);
  fs.mkdirSync(path.dirname(discussionPath), { recursive: true });
  fs.writeFileSync(discussionPath, htmlContent, "utf-8");
  console.log(`Generated: ${path.resolve(discussionPath)}`);

  const result: FileResult = {
    discussionPath,
    dashboardPath: null,
    title: titleFromMarkdown(inputPath),
    metrics: null,
  };

  // Dashboard data can come from the .md's own embedded block (self-contained
  // export) or, for backward compatibility, a sibling <name>.json sidecar. The
  // embedded block wins so a hand-carried .md renders a dashboard on its own.
  const embedded = extractEmbeddedSidecar(fs.readFileSync(inputPath, "utf-8"));
  const sidecarPath = inputPath.replace(/\.[^.]+$/, ".json");
  let sidecar = embedded;
  let source = "embedded block";
  if (!sidecar && fs.existsSync(sidecarPath)) {
    try {
      sidecar = JSON.parse(fs.readFileSync(sidecarPath, "utf-8"));
      source = sidecarPath;
    } catch (e) {
      console.error(`  Dashboard error for ${sidecarPath}: ${e}`);
    }
  }
  if (sidecar) {
    const dashboardPath = outputPath.replace(/\.html$/i, "-dashboard.html");
    try {
      fs.writeFileSync(dashboardPath, generateDashboardHtml(sidecar), "utf-8");
      console.log(`Generated: ${path.resolve(dashboardPath)}`);
      result.dashboardPath = dashboardPath;
      result.metrics = summarizeSidecar(sidecar);
      if (result.metrics.title) result.title = result.metrics.title;
    } catch (e) {
      console.error(`  Dashboard error (${source}): ${e}`);
    }
  }
  return result;
}

// A subagent/workflow transcript is exported into a `<ts>-<prefix>-subagents/`
// or `<ts>-<prefix>-workflows/<run>/` directory sitting beside its parent
// `<ts>-<prefix>.md`. Given a markdown path relative to the scan root, return
// the parent main discussion's key (its path minus the extension) plus whether
// this file is a nested child — so the index can nest children under their
// main. `kind === null` means the file is itself a main discussion.
function classifyEntry(rel: string): { mainKey: string; kind: "subagent" | "workflow" | null } {
  const segs = rel.split(path.sep);
  const dirIdx = segs.findIndex((s) => /-(subagents|workflows)$/.test(s));
  if (dirIdx !== -1) {
    const seg = segs[dirIdx]!;
    const kind = seg.endsWith("-subagents") ? "subagent" : "workflow";
    const base = seg.replace(/-(subagents|workflows)$/, "");
    return { mainKey: [...segs.slice(0, dirIdx), base].join(path.sep), kind };
  }
  return { mainKey: rel.replace(/\.[^.]+$/, ""), kind: null };
}

// Recursively collect markdown files under `dir`, relative to it.
function findMarkdownFiles(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...findMarkdownFiles(full, base));
    } else if (/\.(md|markdown)$/i.test(entry.name)) {
      out.push(path.relative(base, full));
    }
  }
  return out.sort();
}

function main() {
  if (process.argv.length < 3) {
    console.error(`Usage: ${process.argv[1]} <input.md | input-dir> [output.html | output-dir]`);
    process.exit(1);
  }

  const inputPath = process.argv[2]!;
  const outArg = process.argv[3];

  const stat = fs.statSync(inputPath);
  if (stat.isDirectory()) {
    // Directory mode: recursively convert every markdown file inside, mirroring
    // the tree under the output directory (defaults to the input directory, so
    // each .html lands next to its source).
    const mdFiles = findMarkdownFiles(inputPath);

    if (!mdFiles.length) {
      console.error(`No markdown files found in ${inputPath}`);
      process.exit(1);
    }

    const outDir = outArg ?? inputPath;
    const converted: Array<{ rel: string; result: FileResult }> = [];
    for (const rel of mdFiles) {
      const src = path.join(inputPath, rel);
      const dest = path.join(outDir, rel.replace(/\.[^.]+$/, ".html"));
      converted.push({ rel, result: convertFile(src, dest) });
    }

    // An index listing every converted conversation, links + a live grouped
    // total. Hrefs are relative to the index at the output-directory root.
    const relHref = (p: string): string =>
      path.relative(outDir, p).split(path.sep).join("/");
    const toEntry = (r: FileResult): IndexEntry => ({
      title: r.title,
      discussionHref: relHref(r.discussionPath),
      dashboardHref: r.dashboardPath ? relHref(r.dashboardPath) : null,
      totalCost: r.metrics?.totalCost ?? 0,
      peakContext: r.metrics?.peakContext ?? 0,
      durationSeconds: r.metrics?.durationSeconds ?? 0,
      linesAdded: r.metrics?.linesAdded ?? 0,
      linesRemoved: r.metrics?.linesRemoved ?? 0,
      hasMetrics: r.metrics !== null,
    });

    // Nest subagent/workflow transcripts under the main discussion that spawned
    // them, ordered chronologically (their filenames lead with a sortable
    // timestamp). Main discussions stay in the source scan order.
    const mains = new Map<string, { entry: IndexEntry; rel: string }>();
    const kids = new Map<string, Array<{ entry: IndexEntry; rel: string }>>();
    for (const { rel, result } of converted) {
      const entry = toEntry(result);
      const { mainKey, kind } = classifyEntry(rel);
      if (kind === null) {
        mains.set(mainKey, { entry, rel });
      } else {
        entry.kind = kind;
        (kids.get(mainKey) ?? kids.set(mainKey, []).get(mainKey)!).push({ entry, rel });
      }
    }

    const topLevel: Array<{ entry: IndexEntry; order: string }> = [];
    for (const [key, { entry, rel }] of mains) {
      const cs = kids.get(key);
      if (cs) {
        cs.sort((a, b) => path.basename(a.rel).localeCompare(path.basename(b.rel)));
        entry.children = cs.map((c) => c.entry);
        kids.delete(key);
      }
      topLevel.push({ entry, order: rel });
    }
    // Children whose main discussion wasn't in the scan — surface them as their
    // own rows so nothing is silently dropped from the index.
    for (const cs of kids.values()) {
      for (const c of cs) topLevel.push({ entry: c.entry, order: c.rel });
    }
    topLevel.sort((a, b) => a.order.localeCompare(b.order));
    const entries: IndexEntry[] = topLevel.map((t) => t.entry);
    const indexPath = path.join(outDir, "index.html");
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(indexPath, generateIndexHtml(entries), "utf-8");
    console.log(`Generated: ${path.resolve(indexPath)}`);

    console.log(`Converted ${mdFiles.length} file(s).`);
  } else {
    const outputPath = outArg || inputPath.replace(/\.[^.]+$/, ".html");
    convertFile(inputPath, outputPath);
  }
}

main();
