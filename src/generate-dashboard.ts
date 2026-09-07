#!/usr/bin/env tsx
// generate-dashboard v1.0 – Render a Claude Code conversation "dashboard" report
// from the structured sidecar JSON emitted by cca-export. Dark theme, matching
// the discussion viewer (generate-html.ts). Cost is computed here from token
// usage, so the price table lives with the renderer.

import * as fs from "fs";
import * as path from "path";
import { attr, escape, fmtDuration, fmtMoney, fmtOffset, fmtTokens } from "./html/format.ts";
import { noUsageBody, noUsageHeadline, noUsageShort } from "./no-usage.ts";
import {
  contextLimitOf,
  costOf,
  resolveModel,
  withCatalog,
  type ModelCatalog,
} from "./models.ts";
import type { Sidecar, TimelinePoint } from "./sidecar.ts";
import type { SetupItem, Usage } from "./sources/types.ts";

// --- Pricing ---
// Prices and context limits come from the shared models.dev-shaped catalog in
// `models.ts`, merged with any per-export entries the sidecar carried for
// providers the built-in catalog doesn't know (OpenCode exports).

function catalogOf(s: Sidecar): ModelCatalog {
  return withCatalog(s.models);
}

// --- Model colors (align with the discussion viewer accents) ---
// Keyed by the family the catalog resolves, so every Opus variant shares one
// colour and unknown providers get a stable hue hashed from their id rather
// than all collapsing onto the same fallback.
const MODEL_COLOR_BY_FAMILY: Record<string, string> = {
  "claude-opus": "#58a6ff",
  "claude-sonnet": "#3fb950",
  "claude-haiku": "#bc8cff",
  "claude-fable": "#ffa657",
  synthetic: "#6e7681",
};

// Deterministic hue for a model with no known family, so the same provider/model
// keeps its colour across reports.
function hashedColor(model: string): string {
  let h = 0;
  for (let i = 0; i < model.length; i++) h = (h * 31 + model.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360}, 62%, 62%)`;
}

function buildModelColors(models: string[], catalog: ModelCatalog): Record<string, string> {
  const out: Record<string, string> = {};
  for (const model of models) {
    const family = resolveModel(model, catalog).family;
    out[model] = MODEL_COLOR_BY_FAMILY[family] ?? hashedColor(model);
  }
  return out;
}

// The band above the timeline shows what the session was *in* at each moment.
// For Claude Code that is the permission mode; OpenCode has no such field, so
// the same band carries its agent/mode instead (§4.2 of the OpenCode spec) —
// two different things, so they get separate labels and a separate caption.
const MODE_META: Record<string, { label: string; color: string }> = {
  default: { label: "⌨️ Normal", color: "#768390" },
  acceptEdits: { label: "⚡ Auto-accept", color: "#d29922" },
  plan: { label: "📝 Plan", color: "#8957e5" },
  bypassPermissions: { label: "⏭️ Bypass", color: "#da3633" },
};

const AGENT_MODE_META: Record<string, { label: string; color: string }> = {
  build: { label: "⌨️ Build", color: "#768390" },
  plan: { label: "📝 Plan", color: "#8957e5" },
  explore: { label: "🔎 Explore", color: "#56d4dd" },
  general: { label: "🧩 General", color: "#d29922" },
  // Cursor's `unifiedMode`, which is the same axis as OpenCode's agent — what
  // the session was *doing*, not what it was permitted to do.
  agent: { label: "🤖 Agent", color: "#768390" },
  chat: { label: "💬 Chat", color: "#56d4dd" },
  edit: { label: "✏️ Edit", color: "#d29922" },
};

// Label + colour for one band segment. Custom OpenCode agents aren't in the
// table, so they get their name and a hue hashed from it.
function modeMeta(mode: string, source: Sidecar["source"]): { label: string; color: string } {
  if (source === "opencode" || source === "cursor") {
    return AGENT_MODE_META[mode] ?? { label: mode, color: hashedColor(mode) };
  }
  return MODE_META[mode] ?? { label: mode, color: "#768390" };
}

function fmtStartDate(iso: string, timeZone: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone,
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(d);
  } catch {
    return iso;
  }
}

// --- Cost / context computation ---

interface CostContext {
  mainCost: number;
  subagentCost: number;
  totalCost: number;
  peakContext: number;
  models: string[];
  // Largest context window across the models this session used — the ceiling
  // the context curve is drawn against.
  contextLimit: number;
  // Cumulative-cost + context series over the usage points, in time order.
  series: Array<{ t: number; cum: number; ctx: number }>;
}

function computeCost(s: Sidecar): CostContext {
  const catalog = catalogOf(s);
  const modelSet = new Set<string>();
  // One API response is emitted as several timeline points sharing the *same*
  // `usage` (the assistant text point plus each of its tool_use siblings).
  // Collapse consecutive-equal usage so each response is priced once — filtering
  // by `usage` alone counts a text+tools turn multiple times.
  let prevKey: string | null = null;
  const usagePoints = s.timeline
    .filter((p): p is TimelinePoint & { usage: Usage; model: string } => !!p.usage)
    .filter((p) => {
      const key = `${p.usage.in},${p.usage.out},${p.usage.cw},${p.usage.cr}`;
      if (key === prevKey) return false;
      prevKey = key;
      return true;
    })
    .map((p) => ({ ...p, model: p.model || "claude-opus-4-8" }))
    .sort((a, b) => a.t - b.t);

  let cum = 0;
  let peak = 0;
  const series: Array<{ t: number; cum: number; ctx: number }> = [];
  for (const p of usagePoints) {
    modelSet.add(p.model);
    cum += costOf(p.usage, p.model, catalog);
    const ctx = p.usage.in + p.usage.cw + p.usage.cr;
    if (ctx > peak) peak = ctx;
    series.push({ t: p.t, cum, ctx });
  }
  const mainCost = cum;

  let subagentCost = 0;
  for (const [model, u] of Object.entries(s.subagentUsageByModel)) {
    modelSet.add(model);
    subagentCost += costOf(u, model, catalog);
  }

  return {
    mainCost,
    subagentCost,
    totalCost: mainCost + subagentCost,
    peakContext: peak,
    models: [...modelSet].sort(),
    contextLimit: contextLimitOf([...modelSet], catalog),
    series,
  };
}

// Condensed per-conversation metrics for the multi-discussion index page.
// Exposes just the headline numbers (cost/context/duration/change) so the
// index can list many conversations without re-deriving the full dashboard.
export interface SidecarSummary {
  title: string;
  totalCost: number;
  peakContext: number;
  durationSeconds: number;
  linesAdded: number;
  linesRemoved: number;
  // False when the source recorded no token usage, so the index shows `n/a`
  // rather than a $0.00 that would sort as the cheapest session in the list.
  hasCost: boolean;
  source?: Sidecar["source"];
}

export function summarizeSidecar(s: Sidecar): SidecarSummary {
  const cc = computeCost(s);
  const summary: SidecarSummary = {
    title: (s.title || "").trim(),
    totalCost: cc.totalCost,
    peakContext: cc.peakContext,
    durationSeconds: s.durationSeconds || 0,
    linesAdded: s.stats?.linesAdded ?? 0,
    linesRemoved: s.stats?.linesRemoved ?? 0,
    hasCost: s.usageAvailable !== false,
  };
  if (s.source) summary.source = s.source;
  return summary;
}

// --- SVG dual chart (cumulative cost + context tokens over time) ---

function costContextChart(s: Sidecar, cc: CostContext): string {
  const W = 1000;
  const H = 240;
  const padL = 54;
  const padR = 54;
  const padT = 16;
  const padB = 28;
  const dur = s.durationSeconds || 1;

  const costMax = niceMax(cc.mainCost) || 1;
  // Ceiling from the models actually used; never below the peak the session hit.
  const ctxLimit = Math.max(cc.contextLimit, cc.peakContext);

  const x = (t: number) => padL + (t / dur) * (W - padL - padR);
  const yCost = (c: number) => H - padB - (c / costMax) * (H - padT - padB);
  const yCtx = (v: number) => H - padB - (v / ctxLimit) * (H - padT - padB);

  const costPts = cc.series.map((p) => `${x(p.t).toFixed(1)},${yCost(p.cum).toFixed(1)}`).join(" ");
  const ctxPts = cc.series.map((p) => `${x(p.t).toFixed(1)},${yCtx(p.ctx).toFixed(1)}`).join(" ");

  // Context area (fill under the line).
  const ctxArea =
    cc.series.length > 1
      ? `M ${x(cc.series[0]!.t).toFixed(1)},${(H - padB).toFixed(1)} ` +
        cc.series.map((p) => `L ${x(p.t).toFixed(1)},${yCtx(p.ctx).toFixed(1)}`).join(" ") +
        ` L ${x(cc.series[cc.series.length - 1]!.t).toFixed(1)},${(H - padB).toFixed(1)} Z`
      : "";

  // Gridlines / axis labels.
  const rows = 4;
  const grid: string[] = [];
  for (let r = 0; r <= rows; r++) {
    const yy = padT + (r / rows) * (H - padT - padB);
    const costVal = costMax * (1 - r / rows);
    const ctxVal = ctxLimit * (1 - r / rows);
    grid.push(`<line x1="${padL}" y1="${yy.toFixed(1)}" x2="${W - padR}" y2="${yy.toFixed(1)}" class="grid"/>`);
    grid.push(`<text x="${padL - 6}" y="${(yy + 3).toFixed(1)}" class="axl axl-cost" text-anchor="end">${fmtMoney(costVal)}</text>`);
    grid.push(`<text x="${W - padR + 6}" y="${(yy + 3).toFixed(1)}" class="axl axl-ctx" text-anchor="start">${fmtTokens(ctxVal)}</text>`);
  }

  return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Cost and context over time">
  ${grid.join("\n  ")}
  ${ctxArea ? `<path d="${ctxArea}" class="ctx-area"/>` : ""}
  ${ctxPts ? `<polyline points="${ctxPts}" class="ctx-line"/>` : ""}
  ${costPts ? `<polyline points="${costPts}" class="cost-line"/>` : ""}
</svg>`;
}

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / pow;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * pow;
}

// --- Message-history timeline track ---

function timelineTrack(s: Sidecar, modelColors: Record<string, string>): string {
  const dur = s.durationSeconds || 1;
  const pct = (t: number) => ((t / dur) * 100).toFixed(3);

  const modeSegs = s.permissionSegments
    .map((seg) => {
      const meta = modeMeta(seg.mode, s.source);
      const left = pct(seg.start);
      const width = (((seg.end - seg.start) / dur) * 100).toFixed(3);
      return `<div class="mode-seg" style="left:${left}%; width:${width}%; background:${meta.color}" title="${attr(meta.label)} · ${fmtOffset(seg.start)}–${fmtOffset(seg.end)}"><span>${escape(meta.label)}</span></div>`;
    })
    .join("");

  const markers = s.timeline
    .map((p) => {
      const left = pct(p.t);
      const isPrompt = p.kind === "prompt";
      const color = isPrompt ? "#3fb950" : p.model ? modelColors[p.model] || "#8b949e" : "#8b949e";
      const cls = ["marker", `k-${p.kind}`, p.kind === "thinking" ? "is-thinking" : ""].filter(Boolean).join(" ");
      const parts = [`T+${fmtOffset(p.t)}`, p.kind + (p.tool ? `: ${p.tool}` : ""), p.model || "", p.subagentModel ? `→ ${p.subagentModel}` : "", p.label || ""].filter(Boolean);
      return `<span class="${cls}" style="left:${left}%; --mk:${color}" data-tip="${attr(parts.join("\n"))}"></span>`;
    })
    .join("");

  // Time axis labels at quarters.
  const ticks: string[] = [];
  for (let q = 0; q <= 4; q++) {
    const t = (q / 4) * dur;
    ticks.push(`<span class="axis-tick" style="left:${((q / 4) * 100).toFixed(1)}%">T+${fmtOffset(t)}</span>`);
  }

  return `<div class="track-wrap">
  <div class="mode-band">${modeSegs}</div>
  <div class="track">${markers}</div>
  <div class="time-axis">${ticks.join("")}</div>
</div>`;
}

// --- Sections ---

function heroSection(s: Sidecar): string {
  const chips = [fmtStartDate(s.start, s.timeZone), s.branch, s.cwd]
    .filter(Boolean)
    .map((c) => `<span>${escape(c)}</span>`)
    .join("");
  const title = s.title.trim() || "Untitled conversation";
  return `<div class="hero">
  <div class="eyebrow">Conversation report</div>
  <h1>${escape(title.length > 160 ? title.slice(0, 160) + "…" : title)}</h1>
  <div class="subtitle">${chips}</div>
</div>`;
}

// A persistent banner at the top of the report. The cost row carries the same
// note, but the cost row can be scrolled past — and a reader who opens this
// page out of context must not be able to mistake the missing numbers for
// measured ones.
function noUsageBanner(s: Sidecar): string {
  if (s.usageAvailable !== false) return "";
  return `<div class="banner"><strong>${escape(noUsageHeadline(s.source))}</strong> ${escape(noUsageBody(s.source))}</div>`;
}

function statTiles(s: Sidecar, cc: CostContext): string {
  // Whole-session counts (main thread + subagents). `sub` is the subagent-only
  // portion, shown as a per-tile note so the split is visible without a second
  // set of tiles.
  const tc = s.stats.toolCounts;
  const sub = s.stats.subagent;
  const stc = sub?.toolCounts;
  const toolNote = (n: number | undefined): string | undefined =>
    n && n > 0 ? `${n} by subagents` : undefined;
  // Additions/deletions stacked on two lines, GitHub-style green/red.
  const linesChangedHtml =
    `<div class="stat-value stat-diff">` +
    `<span class="add">+${s.stats.linesAdded}</span>` +
    `<span class="del">−${s.stats.linesRemoved}</span></div>`;
  const linesNote =
    sub && (sub.linesAdded > 0 || sub.linesRemoved > 0)
      ? `subagents +${sub.linesAdded}/−${sub.linesRemoved}`
      : undefined;
  // A tile's value is either escaped plain text or a pre-built HTML fragment
  // (4th tuple slot), used for the two-line diff stat.
  // A source that records no usage gets `n/a`, not `$0.00` — and keeps its
  // tile, because a hole in the grid reads as a layout bug while `n/a` reads as
  // a fact. The footnote marker points at the callout that explains it.
  const noUsage = s.usageAvailable === false;
  const tiles: Array<[string, string, string?, string?]> = [
    noUsage
      ? ["Total cost", "", noUsageShort(s.source), `<div class="stat-value stat-na" title="${attr(noUsageShort(s.source))}">n/a<sup>*</sup></div>`]
      : ["Total cost", fmtMoney(cc.totalCost)],
    ["Duration", fmtDuration(s.durationSeconds)],
    ["Lines changed", "", linesNote, linesChangedHtml],
    ["Models", String(cc.models.length), cc.models.map((m) => m.replace(/^claude-/, "")).join(", ")],
    ["Human turns", String(s.stats.humanTurns)],
    ["Read", String(tc.read), toolNote(stc?.read)],
    ["Search", String(tc.search), toolNote(stc?.search)],
    ["Bash", String(tc.bash), toolNote(stc?.bash)],
    ["Edit", String(tc.edit), toolNote(stc?.edit)],
    ["Other", String(tc.other), toolNote(stc?.other)],
  ];
  return `<div class="stats">${tiles
    .map(([label, value, note, valueHtml]) => {
      const valEl = valueHtml ?? `<div class="stat-value">${escape(value)}</div>`;
      return `<div class="stat"><div class="stat-label">${escape(label)}</div>${valEl}${note ? `<div class="stat-note" title="${attr(note)}">${escape(note)}</div>` : ""}</div>`;
    })
    .join("")}</div>`;
}

// What fills the slot the cost/context chart would occupy when the source
// recorded no usage. The chart's context axis is as unusable as its cost axis —
// both are drawn from `TimelinePoint.usage` — so neither is degraded into a
// flat line at zero. In its place: the disclaimer, and the one thing Cursor
// *does* record about context that the other sources don't.
function noUsageSection(s: Sidecar): string {
  const b = s.contextBreakdown;
  const breakdown =
    b && b.categories.length
      ? (() => {
          const max = Math.max(...b.categories.map((c) => c.tokens), 1);
          const bars = b.categories
            .slice()
            .sort((x, y) => y.tokens - x.tokens)
            .map(
              (c) =>
                `<div class="bd-row"><span class="bd-label">${escape(c.label)}</span>` +
                `<span class="bd-bar"><i style="width:${((c.tokens / max) * 100).toFixed(1)}%"></i></span>` +
                `<span class="bd-val">${fmtTokens(c.tokens)}</span></div>`,
            )
            .join("");
          const pct = b.maxTokens ? ` · ${((b.usedTokens / b.maxTokens) * 100).toFixed(0)}% of the window` : "";
          return `<div class="row-meta"><span>context used <strong>${fmtTokens(b.usedTokens)}</strong></span>` +
            `${b.maxTokens ? `<span>window <strong>${fmtTokens(b.maxTokens)}</strong></span>` : ""}` +
            `<span>${escape(pct.replace(/^ · /, ""))}</span></div>` +
            `<div class="breakdown">${bars}</div>`;
        })()
      : `<div class="empty-note">This session recorded no context breakdown either.</div>`;

  return `<div class="row">
  <div class="row-label"><strong>Cost &amp; context</strong><span>Not recorded by this source — see the note.</span></div>
  <div class="row-body">
    <div class="callout" id="no-usage"><strong>${escape(noUsageHeadline(s.source))}</strong> ${escape(noUsageBody(s.source))}</div>
    <div class="bd-head">Estimated context occupancy at the end of the session, by category — the source's own figures, not a measurement of any single turn.</div>
    ${breakdown}
  </div>
</div>`;
}

function costSection(s: Sidecar, cc: CostContext): string {
  if (s.usageAvailable === false) return noUsageSection(s);
  const meta = [
    `total <strong>${fmtMoney(cc.totalCost)}</strong>`,
    `main <strong>${fmtMoney(cc.mainCost)}</strong>`,
    `subagents <strong>${fmtMoney(cc.subagentCost)}</strong>`,
    `peak context <strong>${fmtTokens(cc.peakContext)}</strong>`,
  ]
    .map((m) => `<span>${m}</span>`)
    .join("");
  return `<div class="row">
  <div class="row-label"><strong>Cost &amp; context</strong><span>Cumulative cost (left) and context tokens (right) over time.</span></div>
  <div class="row-body">
    <div class="row-meta">${meta}</div>
    <div class="chart-legend">
      <span><i class="sw sw-cost"></i> Cumulative cost</span>
      <span><i class="sw sw-ctx"></i> Context tokens</span>
    </div>
    ${costContextChart(s, cc)}
  </div>
</div>`;
}

function subagentSection(s: Sidecar): string {
  const dur = s.durationSeconds || 1;
  const body = s.subagents.length
    ? `<div class="subagent-track">${s.subagents
        .map((a) => {
          const left = ((a.t / dur) * 100).toFixed(3);
          const tip = [`T+${fmtOffset(a.t)}`, `type: ${a.type}`, a.model ? `model: ${a.model}` : "", a.description, a.input].filter(Boolean).join("\n");
          return `<span class="subagent-pill" style="left:${left}%" data-tip="${attr(tip)}">${escape(a.type)}</span>`;
        })
        .join("")}</div>`
    : `<div class="empty-note">No subagents spawned in this conversation.</div>`;
  return `<div class="row">
  <div class="row-label"><strong>Spawned subagents</strong><span>${s.subagents.length} spawn(s), positioned by time.</span></div>
  <div class="row-body">${body}</div>
</div>`;
}

function messageSection(s: Sidecar, modelColors: Record<string, string>): string {
  const modelLegend = Object.entries(modelColors)
    .map(([m, c]) => `<span class="chip" style="--mk:${c}"><i></i>${escape(m.replace(/^claude-/, ""))}</span>`)
    .join("");
  return `<div class="row">
  <div class="row-label">
    <strong>Main thread message history</strong>
    <span>${s.source === "opencode" ? "Band: active agent / mode." : s.source === "cursor" ? "Band: session mode." : "Band: permission mode."}</span>
    <div class="legend">${modelLegend}<span class="chip chip-prompt"><i></i>prompt</span></div>
    <button class="toggle-btn" id="thinking-toggle" type="button" aria-pressed="true">Hide 🧠 thinking</button>
  </div>
  <div class="row-body">${timelineTrack(s, modelColors)}</div>
</div>`;
}

function setupColumn(scope: string, title: string, items: SetupItem[]): string {
  const group = (kind: "agent" | "skill", label: string) => {
    const list = items.filter((i) => i.kind === kind);
    const body = list.length
      ? `<div class="setup-list">${list
          .map((i) => `<div class="setup-item" title="${attr(i.description)}"><span class="setup-name">${escape(i.name)}</span>${i.description ? `<span class="setup-desc">${escape(i.description)}</span>` : ""}</div>`)
          .join("")}</div>`
      : `<div class="empty-note">None configured.</div>`;
    return `<div class="setup-group"><div class="setup-group-head">${label} <span class="badge">${list.length}</span></div>${body}</div>`;
  };
  return `<div class="setup-column">
  <div class="setup-column-head"><span class="setup-scope">${escape(scope)}</span><h3>${escape(title)}</h3></div>
  ${group("agent", "Agents")}
  ${group("skill", "Skills")}
</div>`;
}

function setupSection(s: Sidecar): string {
  const count = s.setup.project.length + s.setup.user.length;
  return `<section class="panel">
  <div class="section-head"><span class="eyebrow">Environment · Claude configuration</span><h2>Claude setup <span class="badge">${count} items</span></h2></div>
  <div class="section-note">Read from the <code>.claude</code> directories at generation time — reflects current on-disk config, which may differ from what was active during the conversation.</div>
  <div class="setup-columns">
    ${setupColumn(".claude/", "Local project", s.setup.project)}
    ${setupColumn("~/.claude/", "User root", s.setup.user)}
  </div>
</section>`;
}

function diffSection(s: Sidecar): string {
  if (!s.diffs.length) return "";
  // Main-thread edits first, then subagent edits — each still tagged inline so
  // origin is clear regardless of order.
  const ordered = [...s.diffs].sort(
    (a, b) => (a.origin === "subagent" ? 1 : 0) - (b.origin === "subagent" ? 1 : 0),
  );
  const entries = ordered
    .map((d) => {
      const name = d.filePath.split("/").pop() || d.filePath;
      const badge = d.origin === "subagent" ? `<span class="origin-badge">subagent</span>` : "";
      const lines = d.hunk
        .map((l) => {
          const cls = l.type === "add" ? "d-add" : l.type === "del" ? "d-del" : "d-ctx";
          const prefix = l.type === "add" ? "+" : l.type === "del" ? "-" : " ";
          return `<span class="${cls}">${escape(prefix + l.text)}</span>`;
        })
        .join("\n");
      return `<details class="diff-entry">
  <summary><span class="op op-${d.op.toLowerCase()}">${d.op}</span><span class="diff-path" title="${attr(d.filePath)}">${escape(name)}</span>${badge}<span class="diff-stat">+${d.added} / -${d.removed}</span></summary>
  <pre class="diff-body">${lines}</pre>
</details>`;
    })
    .join("\n");
  const ops = s.diffs.length;
  const subOps = s.diffs.filter((d) => d.origin === "subagent").length;
  const subNote = subOps ? ` · ${subOps} by subagents` : "";
  return `<section class="panel">
  <div class="section-head"><span class="eyebrow">Output · File changes</span><h2>Generated diffs <span class="badge">${ops} operations${subNote}</span></h2></div>
  <div class="diff-entries">${entries}</div>
</section>`;
}

// --- Page assembly ---

const SOURCE_LABEL: Record<string, string> = {
  "claude-code": "Claude Code",
  opencode: "OpenCode",
  cursor: "Cursor",
};

function footerNote(s: Sidecar): string {
  const agent = SOURCE_LABEL[s.source ?? "claude-code"] ?? "";
  const id = `Session ID: ${escape(s.uuid)}${agent ? ` · ${agent}` : ""}${s.version ? ` ${escape(s.version)}` : ""}.`;
  if (s.usageAvailable === false) {
    // No prices to explain, and explaining the cost model anyway would imply
    // one had been applied.
    return `${id} ${escape(noUsageBody(s.source))} Line counts, tool tallies, timings and diffs are read from the source transcript.`;
  }
  return (
    `${id} Cost is computed from token usage using the model's published prices ` +
    `(input · output · cache-creation · cache-read). Context tokens = <code>input + cache_creation + cache_read</code>; ` +
    `the context axis is the largest window across the models the session used.`
  );
}

export function generateDashboardHtml(s: Sidecar): string {
  const cc = computeCost(s);
  const modelColors = buildModelColors(
    cc.models.length ? cc.models : ["claude-opus-4-8"],
    catalogOf(s),
  );

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Conversation Report — ${escape((s.title || s.uuid).slice(0, 60))}</title>
<style>
:root {
  --bg: #0d1117; --surface: #161b22; --surface-2: #1c2128; --border: #30363d;
  --text: #e6edf3; --text-muted: #8b949e;
  --cost: #3fb950; --ctx: #58a6ff;
  --radius: 12px;
  --mono: ui-monospace, SFMono-Regular, Menlo, monospace;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
  background: var(--bg); color: var(--text); line-height: 1.5; padding: 28px 18px 60px;
}
.page { max-width: 1200px; margin: 0 auto; display: grid; gap: 20px; }
.panel { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 22px 24px; }
.eyebrow { font-family: var(--mono); font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--text-muted); }

/* Hero */
.hero { padding-bottom: 8px; }
.hero h1 { font-size: clamp(20px, 2.2vw, 30px); line-height: 1.15; margin: 8px 0 12px; max-width: 40ch; letter-spacing: -0.02em; }
.subtitle { display: flex; gap: 8px; flex-wrap: wrap; }
.subtitle span { font-size: 12px; color: var(--text-muted); background: var(--surface-2); border: 1px solid var(--border); padding: 3px 9px; border-radius: 999px; max-width: 60ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* Stat tiles */
.stats { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 18px; }
.stat { flex: 1 1 90px; background: var(--surface-2); border: 1px solid var(--border); border-radius: 10px; padding: 9px 11px; min-width: 90px; }
.stat-label { font-family: var(--mono); font-size: 9px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-muted); margin-bottom: 5px; }
.stat-value { font-size: 20px; letter-spacing: -0.02em; white-space: nowrap; }
/* Two-line additions/deletions, GitHub green/red. */
.stat-diff { display: flex; flex-direction: column; line-height: 1.15; font-size: 17px; }
.stat-diff .add { color: #3fb950; }
.stat-diff .del { color: #f85149; }
.stat-note { font-size: 11px; color: var(--text-muted); margin-top: 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* Rows (chart / subagents / messages) */
.row { display: grid; grid-template-columns: 220px minmax(0, 1fr); gap: 24px; align-items: start; padding: 20px 0; border-top: 1px solid var(--border); }
.row:first-child { border-top: none; }
.row-label strong { display: block; font-size: 16px; letter-spacing: -0.01em; margin-bottom: 4px; }
.row-label span { color: var(--text-muted); font-size: 13px; line-height: 1.4; }
.row-meta { display: flex; flex-wrap: wrap; gap: 12px; margin-bottom: 10px; font-size: 13px; color: var(--text-muted); }
.row-meta strong { color: var(--text); }

/* Chart */
.chart-legend { display: flex; gap: 16px; font-size: 11px; color: var(--text-muted); margin-bottom: 8px; }
.chart-legend .sw { display: inline-block; width: 18px; height: 3px; border-radius: 2px; vertical-align: middle; margin-right: 5px; }
.sw-cost { background: var(--cost); } .sw-ctx { background: var(--ctx); }
.chart { width: 100%; height: auto; display: block; }
.chart .grid { stroke: rgba(255,255,255,0.06); stroke-width: 1; }
.chart .axl { font-family: var(--mono); font-size: 10px; }
.chart .axl-cost { fill: var(--cost); } .chart .axl-ctx { fill: var(--ctx); }
.chart .cost-line { fill: none; stroke: var(--cost); stroke-width: 2; }
.chart .ctx-line { fill: none; stroke: var(--ctx); stroke-width: 1.5; opacity: 0.9; }
.chart .ctx-area { fill: var(--ctx); opacity: 0.10; }

/* Subagents */
.subagent-track, .track { position: relative; height: 40px; background: var(--surface-2); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
.subagent-pill { position: absolute; top: 8px; transform: translateX(-50%); font-size: 10px; padding: 3px 8px; background: rgba(88,166,255,0.18); border: 1px solid rgba(88,166,255,0.4); border-radius: 999px; white-space: nowrap; cursor: default; }
.empty-note { color: var(--text-muted); font-size: 13px; font-style: italic; padding: 10px 0; }

/* Message timeline */
.legend { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0; }
.chip { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; color: var(--text-muted); background: var(--surface-2); border: 1px solid var(--border); padding: 2px 8px; border-radius: 999px; }
.chip i { width: 8px; height: 8px; border-radius: 50%; background: var(--mk, #8b949e); display: inline-block; }
.chip-prompt i { background: #3fb950; }
.toggle-btn { margin-top: 6px; background: var(--bg); border: 1px solid var(--border); color: var(--text); padding: 4px 10px; border-radius: 6px; cursor: pointer; font-size: 11px; }
.toggle-btn:hover { background: var(--surface-2); }
.toggle-btn.off { opacity: 0.55; }
.track-wrap { position: relative; }
.mode-band { position: relative; height: 18px; margin-bottom: 4px; border-radius: 6px; overflow: hidden; background: var(--surface-2); border: 1px solid var(--border); }
.mode-seg { position: absolute; top: 0; height: 100%; opacity: 0.5; display: flex; align-items: center; overflow: hidden; }
.mode-seg span { font-size: 9px; color: #fff; padding: 0 6px; white-space: nowrap; mix-blend-mode: normal; }
.track { height: 64px; }
.marker { position: absolute; bottom: 0; width: 2px; height: 60%; background: var(--mk); transform: translateX(-1px); cursor: default; }
.marker.k-prompt { height: 100%; width: 2px; background: #3fb950; }
.marker.k-prompt::before { content: ''; position: absolute; top: -3px; left: -3px; width: 8px; height: 8px; border-radius: 50%; background: #3fb950; }
.marker.k-thinking { opacity: 0.7; height: 40%; }
.marker.k-tool_result { opacity: 0.35; height: 30%; }
/* Auto/manual context compaction (OpenCode). A full-height amber rule, so the
   point where the context curve drops is legible on the track too. */
.marker.k-compaction { height: 100%; width: 2px; background: #d29922; }
.marker.k-compaction::before { content: ''; position: absolute; top: -3px; left: -3px; width: 8px; height: 8px; border-radius: 2px; background: #d29922; }
.marker:hover { box-shadow: 0 0 0 1px var(--mk); z-index: 5; }
.track.hide-thinking .is-thinking { display: none; }
.time-axis { position: relative; height: 16px; margin-top: 4px; }
.axis-tick { position: absolute; transform: translateX(-50%); font-family: var(--mono); font-size: 9px; color: var(--text-muted); }
.axis-tick:first-child { transform: none; } .axis-tick:last-child { transform: translateX(-100%); }

/* Sections */
.section-head { display: flex; flex-direction: column; gap: 4px; margin-bottom: 6px; }
.section-head h2 { font-size: 20px; letter-spacing: -0.02em; }
.section-note { color: var(--text-muted); font-size: 12px; margin-bottom: 16px; max-width: 70ch; }
.section-note code { font-family: var(--mono); font-size: 11px; background: var(--surface-2); padding: 1px 4px; border-radius: 3px; }
.badge { font-size: 11px; color: var(--text-muted); background: var(--surface-2); border: 1px solid var(--border); border-radius: 999px; padding: 1px 8px; font-weight: 400; }

/* Setup */
.setup-columns { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 18px; }
.setup-column-head { margin-bottom: 10px; }
.setup-scope { font-family: var(--mono); font-size: 11px; color: var(--text-muted); }
.setup-column-head h3 { font-size: 15px; }
.setup-group { margin-bottom: 14px; }
.setup-group-head { font-size: 12px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 6px; display: flex; align-items: center; gap: 8px; }
.setup-list { display: grid; grid-template-columns: minmax(0, 1fr); gap: 4px; }
.setup-item { min-width: 0; background: var(--surface-2); border: 1px solid var(--border); border-radius: 6px; padding: 6px 9px; }
.setup-name { display: block; font-size: 13px; font-weight: 600; }
.setup-desc { display: block; font-size: 11px; color: var(--text-muted); overflow-wrap: break-word; }

/* Diffs */
.diff-entries { display: grid; gap: 8px; }
.diff-entry { background: var(--surface-2); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
.diff-entry summary { cursor: pointer; padding: 8px 12px; display: flex; align-items: center; gap: 10px; font-size: 13px; user-select: none; }
.diff-entry summary:hover { background: var(--bg); }
.op { font-family: var(--mono); font-size: 10px; text-transform: uppercase; padding: 1px 6px; border-radius: 4px; }
.op-write { background: rgba(63,185,80,0.18); color: #3fb950; }
.op-edit { background: rgba(210,153,34,0.18); color: #d29922; }
.diff-path { font-family: var(--mono); font-size: 12px; }
.origin-badge { font-family: var(--mono); font-size: 9px; text-transform: uppercase; letter-spacing: 0.04em; padding: 1px 6px; border-radius: 999px; background: rgba(88,166,255,0.15); border: 1px solid rgba(88,166,255,0.4); color: #58a6ff; }
.diff-stat { margin-left: auto; font-family: var(--mono); font-size: 11px; color: var(--text-muted); }
.diff-body { padding: 8px 12px; overflow-x: auto; font-family: var(--mono); font-size: 11px; line-height: 1.5; border-top: 1px solid var(--border); }
.diff-body span { display: block; white-space: pre; }
.d-add { color: #7ee787; background: rgba(63,185,80,0.10); }
.d-del { color: #ffa198; background: rgba(218,54,51,0.10); }
.d-ctx { color: var(--text-muted); }

/* Provenance notes (no recorded token usage). Neutral chrome on purpose: this
   is a statement about what the source stored, not an error. */
.banner, .callout {
  background: var(--surface); border: 1px solid var(--border); border-left: 3px solid var(--ctx);
  border-radius: var(--radius); padding: 12px 16px; font-size: 13px; color: var(--text-muted);
  line-height: 1.5; max-width: 100ch;
}
.banner strong, .callout strong { color: var(--text); }
.callout { margin-bottom: 14px; }
.stat-na { color: var(--text-muted); }
.stat-na sup { font-size: 10px; color: var(--ctx); }

/* Context breakdown, shown where the cost chart would be. */
.bd-head { font-size: 12px; color: var(--text-muted); margin-bottom: 10px; max-width: 80ch; }
.breakdown { display: grid; gap: 5px; }
.bd-row { display: grid; grid-template-columns: minmax(90px, 180px) minmax(0, 1fr) 56px; gap: 10px; align-items: center; font-size: 12px; }
.bd-label { color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bd-bar { background: var(--surface-2); border: 1px solid var(--border); border-radius: 4px; height: 14px; overflow: hidden; }
.bd-bar i { display: block; height: 100%; background: var(--ctx); opacity: 0.55; }
.bd-val { font-family: var(--mono); font-size: 11px; color: var(--text); text-align: right; }

.footer-note { color: var(--text-muted); font-size: 11px; line-height: 1.5; max-width: 90ch; margin: 4px auto 0; }
.footer-note code { font-family: var(--mono); background: var(--surface-2); padding: 1px 4px; border-radius: 3px; }

/* Hover tooltip */
#tip { position: fixed; z-index: 999; max-width: 420px; background: #010409; border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; font-size: 12px; line-height: 1.45; color: var(--text); box-shadow: 0 8px 30px rgba(0,0,0,0.6); pointer-events: none; display: none; white-space: pre-wrap; }

@media (max-width: 720px) {
  .row { grid-template-columns: 1fr; gap: 12px; }
  .setup-columns { grid-template-columns: 1fr; }
}
</style>
</head>
<body>
<main class="page">
  ${noUsageBanner(s)}
  <section class="panel">
    ${heroSection(s)}
    ${statTiles(s, cc)}
  </section>
  <section class="panel">
    ${costSection(s, cc)}
    ${subagentSection(s)}
    ${messageSection(s, modelColors)}
  </section>
  ${setupSection(s)}
  ${diffSection(s)}
  <div class="footer-note">${footerNote(s)}</div>
</main>
<div id="tip"></div>
<script>
(function () {
  var tip = document.getElementById('tip');
  document.querySelectorAll('[data-tip]').forEach(function (el) {
    el.addEventListener('mouseenter', function (e) {
      tip.textContent = el.getAttribute('data-tip');
      tip.style.display = 'block';
      move(e);
    });
    el.addEventListener('mousemove', move);
    el.addEventListener('mouseleave', function () { tip.style.display = 'none'; });
  });
  function move(e) {
    var x = e.clientX + 14, y = e.clientY + 14;
    var r = tip.getBoundingClientRect();
    if (x + r.width > window.innerWidth - 10) x = e.clientX - r.width - 14;
    if (y + r.height > window.innerHeight - 10) y = e.clientY - r.height - 14;
    tip.style.left = x + 'px'; tip.style.top = y + 'px';
  }
  var btn = document.getElementById('thinking-toggle');
  var track = document.querySelector('.track');
  if (btn && track) {
    btn.addEventListener('click', function () {
      var hidden = track.classList.toggle('hide-thinking');
      btn.classList.toggle('off', hidden);
      btn.setAttribute('aria-pressed', String(!hidden));
      btn.textContent = hidden ? 'Show 🧠 thinking' : 'Hide 🧠 thinking';
    });
  }
})();
</script>
</body>
</html>`;
}

// --- CLI (standalone: render a sidecar .json to a .html) ---

function main(): void {
  const input = process.argv[2];
  if (!input) {
    console.error("Usage: generate-dashboard <sidecar.json> [output.html]");
    process.exit(1);
  }
  const sidecar: Sidecar = JSON.parse(fs.readFileSync(input, "utf-8"));
  const output = process.argv[3] || input.replace(/\.json$/, "-dashboard.html");
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, generateDashboardHtml(sidecar), "utf-8");
  console.log(`Generated: ${output}`);
}

// Run as a script only when invoked directly (not when imported).
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === `file://${path.resolve(process.argv[1])}`;
if (invokedDirectly) main();
