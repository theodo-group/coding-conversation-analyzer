#!/usr/bin/env tsx
// generate-index v1.0 – Render an index page listing every conversation
// converted in a directory run. One row per discussion (Title, cost, max
// context, duration, change) linking to its discussion + dashboard reports,
// with per-row checkboxes that live-sum the group so several sessions on one
// feature can be analyzed together. Dark theme, matching the other reports.

// One conversation's row. `metrics` is null when no `.json` sidecar sat next
// to the source markdown (no dashboard, no numbers) — the row still links to
// the discussion viewer but contributes nothing to the selected totals.
export interface IndexEntry {
  title: string;
  discussionHref: string;
  dashboardHref: string | null;
  totalCost: number;
  peakContext: number;
  durationSeconds: number;
  linesAdded: number;
  linesRemoved: number;
  hasMetrics: boolean;
}

function escape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtMoney(n: number): string {
  return "$" + n.toFixed(2);
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(Math.round(n));
}

function fmtDuration(sec: number): string {
  const s = Math.round(sec);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m < 60) return `${m}m ${r}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function row(e: IndexEntry): string {
  const links =
    `<a class="lnk" href="${escape(e.discussionHref)}">discussion</a>` +
    (e.dashboardHref ? `<a class="lnk" href="${escape(e.dashboardHref)}">dashboard</a>` : `<span class="lnk lnk-off">dashboard</span>`);

  // Data attributes carry the raw numbers so the client can sum/max the
  // selected rows without re-parsing the formatted cells.
  const cb = e.hasMetrics
    ? `<input type="checkbox" class="pick" checked data-cost="${e.totalCost}" data-ctx="${e.peakContext}" data-dur="${e.durationSeconds}" data-add="${e.linesAdded}" data-del="${e.linesRemoved}">`
    : `<input type="checkbox" class="pick" disabled title="No metrics — sidecar JSON missing">`;

  const num = (html: string) => (e.hasMetrics ? html : `<span class="dash">—</span>`);
  const change = e.hasMetrics
    ? `<span class="add">+${e.linesAdded}</span> <span class="del">−${e.linesRemoved}</span>`
    : `<span class="dash">—</span>`;

  return `<tr>
  <td class="c-pick">${cb}</td>
  <td class="c-title"><span class="title" title="${escape(e.title)}">${escape(e.title)}</span><div class="links">${links}</div></td>
  <td class="c-num">${num(fmtMoney(e.totalCost))}</td>
  <td class="c-num">${num(fmtTokens(e.peakContext))}</td>
  <td class="c-num">${num(fmtDuration(e.durationSeconds))}</td>
  <td class="c-num c-change">${change}</td>
</tr>`;
}

export function generateIndexHtml(entries: IndexEntry[], heading = "Conversations"): string {
  const withMetrics = entries.filter((e) => e.hasMetrics).length;
  const rows = entries.map(row).join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Conversations — index</title>
<style>
:root {
  --bg: #0d1117; --surface: #161b22; --surface-2: #1c2128; --border: #30363d;
  --text: #e6edf3; --text-muted: #8b949e;
  --cost: #3fb950; --ctx: #58a6ff; --accent: #58a6ff;
  --radius: 12px;
  --mono: ui-monospace, SFMono-Regular, Menlo, monospace;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
  background: var(--bg); color: var(--text); line-height: 1.5; padding: 28px 18px 60px;
}
.page { max-width: 1100px; margin: 0 auto; display: grid; gap: 18px; }
.eyebrow { font-family: var(--mono); font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--text-muted); }
h1 { font-size: clamp(20px, 2.2vw, 28px); letter-spacing: -0.02em; margin: 6px 0 2px; }
.sub { color: var(--text-muted); font-size: 13px; }

/* Sticky selected-totals bar */
.totals {
  position: sticky; top: 0; z-index: 10;
  display: flex; flex-wrap: wrap; align-items: center; gap: 10px 20px;
  background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius);
  padding: 12px 18px;
}
.totals .tt-lead { font-size: 13px; color: var(--text-muted); }
.totals .tt-lead strong { color: var(--text); }
.totals .tt { display: flex; flex-direction: column; }
.totals .tt-label { font-family: var(--mono); font-size: 9px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-muted); }
.totals .tt-val { font-size: 18px; letter-spacing: -0.02em; white-space: nowrap; }
.totals .tt-val .add { color: var(--cost); } .totals .tt-val .del { color: #f85149; }
.totals .tt-cost .tt-val { color: var(--cost); }
.totals .tt-ctx .tt-val { color: var(--ctx); }
.totals .spacer { flex: 1 1 auto; }
.totals button { background: var(--bg); border: 1px solid var(--border); color: var(--text); padding: 5px 11px; border-radius: 6px; cursor: pointer; font-size: 12px; }
.totals button:hover { background: var(--surface-2); }

/* Table. The header scrolls with the list — only the totals bar is pinned.
   (A sticky <thead> inside a border-collapse table mis-pins across browsers.) */
.card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
thead th {
  text-align: left; font-family: var(--mono); font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em;
  color: var(--text-muted); font-weight: 600; padding: 10px 14px; border-bottom: 1px solid var(--border);
  background: var(--surface-2);
}
tbody td { padding: 10px 14px; border-bottom: 1px solid var(--border); vertical-align: top; }
tbody tr:last-child td { border-bottom: none; }
tbody tr:hover { background: var(--surface-2); }
.c-pick { width: 34px; }
.c-num { text-align: right; font-family: var(--mono); white-space: nowrap; width: 1%; }
thead .c-num { text-align: right; }
.c-change .add { color: var(--cost); } .c-change .del { color: #f85149; }
.dash { color: var(--text-muted); }
.title { display: block; font-weight: 600; max-width: 56ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.links { margin-top: 3px; display: flex; gap: 12px; }
.lnk { font-size: 11px; color: var(--accent); text-decoration: none; }
.lnk:hover { text-decoration: underline; }
.lnk-off { color: var(--text-muted); text-decoration: none; cursor: default; opacity: 0.6; }
input[type=checkbox] { width: 15px; height: 15px; accent-color: var(--accent); cursor: pointer; }
input[type=checkbox]:disabled { cursor: default; opacity: 0.4; }
.foot-note { color: var(--text-muted); font-size: 11px; line-height: 1.5; max-width: 90ch; }
</style>
</head>
<body>
<main class="page">
  <div>
    <div class="eyebrow">Conversation reports</div>
    <h1>${escape(heading)}</h1>
    <div class="sub">${entries.length} conversation(s)${withMetrics < entries.length ? ` · ${withMetrics} with metrics` : ""}</div>
  </div>

  <div class="totals" id="totals">
    <div class="tt-lead">Selected <strong id="sel-count">0</strong></div>
    <div class="tt tt-cost"><span class="tt-label">Total cost</span><span class="tt-val" id="sum-cost">$0.00</span></div>
    <div class="tt tt-ctx"><span class="tt-label">Max context</span><span class="tt-val" id="sum-ctx">0</span></div>
    <div class="tt"><span class="tt-label">Total duration</span><span class="tt-val" id="sum-dur">0s</span></div>
    <div class="tt"><span class="tt-label">Total change</span><span class="tt-val" id="sum-change"><span class="add">+0</span> <span class="del">−0</span></span></div>
    <div class="spacer"></div>
    <button type="button" id="btn-all">Select all</button>
    <button type="button" id="btn-none">Clear</button>
  </div>

  <div class="card">
    <table>
      <thead>
        <tr>
          <th class="c-pick"></th>
          <th>Title</th>
          <th class="c-num">Cost</th>
          <th class="c-num">Max context</th>
          <th class="c-num">Duration</th>
          <th class="c-num">Change</th>
        </tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>
  </div>

  <div class="foot-note">
    Tick rows to build a group (e.g. all sessions for one feature): cost, duration and change are summed;
    context shows the peak reached across the selection. Cost is computed from token usage — see each dashboard for the breakdown.
    Rows without a checkbox had no <code>.json</code> sidecar next to their markdown, so no metrics or dashboard were generated.
  </div>
</main>

<script>
(function () {
  var picks = Array.prototype.slice.call(document.querySelectorAll('.pick:not(:disabled)'));

  function fmtMoney(n) { return '$' + n.toFixed(2); }
  function fmtTokens(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
    return String(Math.round(n));
  }
  function fmtDuration(sec) {
    var s = Math.round(sec);
    if (s < 60) return s + 's';
    var m = Math.floor(s / 60), r = s % 60;
    if (m < 60) return m + 'm ' + r + 's';
    var h = Math.floor(m / 60);
    return h + 'h ' + (m % 60) + 'm';
  }

  function recompute() {
    var count = 0, cost = 0, ctx = 0, dur = 0, add = 0, del = 0;
    picks.forEach(function (cb) {
      if (!cb.checked) return;
      count++;
      cost += parseFloat(cb.dataset.cost) || 0;
      ctx = Math.max(ctx, parseFloat(cb.dataset.ctx) || 0);
      dur += parseFloat(cb.dataset.dur) || 0;
      add += parseInt(cb.dataset.add, 10) || 0;
      del += parseInt(cb.dataset.del, 10) || 0;
    });
    document.getElementById('sel-count').textContent = count;
    document.getElementById('sum-cost').textContent = fmtMoney(cost);
    document.getElementById('sum-ctx').textContent = fmtTokens(ctx);
    document.getElementById('sum-dur').textContent = fmtDuration(dur);
    document.getElementById('sum-change').innerHTML =
      '<span class="add">+' + add + '</span> <span class="del">−' + del + '</span>';
  }

  picks.forEach(function (cb) { cb.addEventListener('change', recompute); });
  document.getElementById('btn-all').addEventListener('click', function () {
    picks.forEach(function (cb) { cb.checked = true; }); recompute();
  });
  document.getElementById('btn-none').addEventListener('click', function () {
    picks.forEach(function (cb) { cb.checked = false; }); recompute();
  });
  recompute();
})();
</script>
</body>
</html>`;
}
