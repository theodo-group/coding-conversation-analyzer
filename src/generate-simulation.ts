#!/usr/bin/env tsx
// generate-simulation v1.0 – Render a Claude Code conversation "simulation" page
// from the structured sidecar JSON emitted by cca-export. A linear transcript of
// the conversation with a checkbox on every tool call; unchecking a tool
// simulates having never run it, and a sticky side panel recomputes the
// consumption / cost / time impact live in the browser.
//
// This is a *learning tool*, not a recommender: it shows what a message cost the
// session (its context weight cascading through every later API call, plus its
// wall-clock), and lets you toggle to see the numbers move. It deliberately
// offers no advice. The model is an attribution/accounting one — it assumes the
// same conversation trajectory with cheaper context, not a true counterfactual
// re-run (removing a result Claude actually needed would really change what it
// did next).

import * as fs from "fs";
import * as path from "path";
import { attr, escape, fmtOffset, fmtTokens } from "./html/format.ts";
import {
  DEFAULT_MODEL_ID,
  costOf,
  resolveModel,
  resolvedCosts,
  withCatalog,
} from "./models.ts";
import type { Sidecar, TimelinePoint } from "./sidecar.ts";

// --- Pricing ---
// Prices come from the shared models.dev-shaped catalog (`models.ts`), merged
// with any per-export entries the sidecar carried for providers the built-in
// catalog doesn't know. The browser gets a *resolved* price per model string it
// will actually see (see `costs` in the payload), so the client-side recompute
// is a plain lookup with no matching rules or derived multipliers to keep in
// sync with the server.

// --- Attribution model ---
//
// Each Claude Code API response is an "assistant" timeline point carrying a
// `usage`. Its total input-side context is T = in + cw + cr. Between one API
// call k and the next k+1, the context grows by T_{k+1} − T_k; subtracting the
// output tokens of call k (which are appended verbatim to the next prompt)
// leaves the token weight of everything else appended in that gap — i.e. the
// tool results. We split that weight evenly among the tool calls in the gap.
//
// A tool result of weight X, once written to the cache at its entry call, is
// re-read on every later API call until a context reset (a `/compact` or a
// cache miss, detected as a big drop in T). So excluding a tool removes:
//   - its wall-clock (tool_result.t − tool_use.t), and
//   - X tokens from every API call in [entry, exit): a one-time cache-write at
//     the entry call, then a cache-read on each subsequent call.
// The browser reduces each call's cw/cr accordingly and re-runs `costOf`, so the
// cost, peak-context and duration deltas stay faithful to the real price model.

interface SimCall {
  ord: number;
  i: number; // originating timeline index
  t: number;
  model: string;
  in: number;
  out: number;
  cw: number;
  cr: number;
}
interface SimTool {
  id: number; // timeline index of the tool_use point
  tool: string;
  label: string;
  t: number;
  wall: number; // wall-clock seconds (tool_result.t − tool_use.t)
  weight: number | null; // attributed context tokens; null when not derivable
  entry: number; // ordinal of the API call where it enters context
  exit: number; // ordinal where residency ends (reset boundary or call count)
  solo: number; // downstream cost of this one tool alone (USD)
  note?: string;
}
interface Row {
  i: number;
  kind: string;
  t: number;
  cls: string;
  tag: string;
  label: string;
  // tool rows only:
  toolId?: number;
  weight?: number | null;
  wall?: number;
  solo?: number;
  note?: string;
  // assistant rows only:
  model?: string;
  ctx?: number;
}

interface SimData {
  calls: SimCall[];
  tools: SimTool[];
  rows: Row[];
  subagentCost: number;
  duration: number;
}

// Big relative drop in total context ⇒ a reset (compaction / cache miss): prior
// tool results no longer ride along in the prompt.
const RESET_RATIO = 0.5;

// Tools that can add far more to context than their tool_result records — a
// Skill loads its body, a Task/Agent spawn folds in the subagent's work, an MCP
// tool can return/inject a large resource. A turn's unexplained context growth
// is attributed to these (see the residual pass), above a floor so ordinary
// size-estimate slack isn't misattributed.
const RESIDUAL_FLOOR = 1000;

function isInjector(tool: string): boolean {
  return tool === "Skill" || tool === "Task" || tool === "Agent" || tool.startsWith("mcp__");
}

function injectorKind(tool: string): string {
  if (tool === "Skill") return "skill load";
  if (tool === "Task" || tool === "Agent") return "subagent spawn";
  if (tool.startsWith("mcp__")) return "MCP call";
  return "call";
}

function buildSim(s: Sidecar): SimData {
  const tl = s.timeline;

  // API calls, in chronological order. One API response is emitted as several
  // timeline points that all carry the *same* `usage` (the assistant text point
  // plus each of its tool_use sibling points; a tool-only response has no text
  // point at all). Collapse consecutive-equal usage so each response counts once
  // — filtering by kind alone would double-count text+tool turns and miss
  // tool-only ones. The call's `i` is its first point, so gap grouping by
  // timeline index maps each later tool_use into the right call.
  const calls: SimCall[] = [];
  let lastKey: string | null = null;
  for (const p of tl) {
    if (!p.usage) continue;
    const key = `${p.usage.in},${p.usage.out},${p.usage.cw},${p.usage.cr}`;
    if (key === lastKey) continue;
    lastKey = key;
    calls.push({
      ord: calls.length,
      i: p.i,
      t: p.t,
      model: p.model || "claude-opus-4-8",
      in: p.usage.in,
      out: p.usage.out,
      cw: p.usage.cw,
      cr: p.usage.cr,
    });
  }
  const ctxOf = (c: SimCall) => c.in + c.cw + c.cr;

  // Reset boundaries: ordinal of each call whose context collapsed vs the prior.
  const resets: number[] = [];
  for (let k = 1; k < calls.length; k++) {
    if (ctxOf(calls[k]!) < RESET_RATIO * ctxOf(calls[k - 1]!)) resets.push(k);
  }
  const nextResetAfter = (entry: number): number => {
    for (const r of resets) if (r > entry) return r;
    return calls.length;
  };

  // Map a timeline index to the ordinal of the API call that owns it (the most
  // recent assistant call at or before it), for gap grouping.
  const callAtOrBefore = (idx: number): number => {
    let ord = -1;
    for (const c of calls) {
      if (c.i <= idx) ord = c.ord;
      else break;
    }
    return ord;
  };

  // Pair each tool_use with its matching (next unclaimed) tool_result, in order,
  // to recover both wall-clock (result.t − tool.t) and the result size.
  const results = tl.filter((p) => p.kind === "tool_result").map((p) => ({ t: p.t, out: p.outChars ?? 0 }));
  let resultCursor = 0;
  const resultFor = (toolT: number): { wall: number; out: number } => {
    while (resultCursor < results.length && results[resultCursor]!.t < toolT) resultCursor++;
    if (resultCursor < results.length) {
      const r = results[resultCursor++]!;
      return { wall: Math.max(0, r.t - toolT), out: r.out };
    }
    return { wall: 0, out: 0 };
  };
  const outCharsById = new Map<number, number>();
  const wallById = new Map<number, number>();

  // Pass A — pair every tool_use with its result (in order), and group tool_use
  // points by the API call that emitted them, so a turn's context weight can be
  // apportioned across its parallel tools.
  const toolsByGapCall = new Map<number, TimelinePoint[]>(); // key: preceding call ordinal
  for (const p of tl) {
    if (p.kind !== "tool_use") continue;
    const r = resultFor(p.t);
    outCharsById.set(p.i, r.out);
    wallById.set(p.i, r.wall);
    const owner = callAtOrBefore(p.i);
    const arr = toolsByGapCall.get(owner) ?? [];
    arr.push(p);
    toolsByGapCall.set(owner, arr);
  }

  // The exact context growth of a turn (from differencing) that owns exactly one
  // tool IS that tool's token weight for a known result size — so single-tool
  // turns calibrate a chars→tokens ratio for this session. We reuse it to size
  // the tools in multi-tool turns from their own output, instead of smearing the
  // turn's total across them: a turn can grow from things a tool_result doesn't
  // carry (skill/system injection, user pastes), and splitting that onto the
  // tools would misattribute it (e.g. make trivial TaskCreates look huge).
  const gapWeightOf = (ownerOrd: number): number => {
    const owner = calls[ownerOrd];
    const next = owner ? calls[owner.ord + 1] : undefined;
    return owner && next ? Math.max(0, ctxOf(next) - ctxOf(owner) - owner.out) : 0;
  };
  let calChars = 0;
  let calWeight = 0;
  for (const [ownerOrd, sibs] of toolsByGapCall) {
    if (sibs.length !== 1) continue;
    const oc = outCharsById.get(sibs[0]!.i) ?? 0;
    if (oc <= 0) continue;
    calChars += oc;
    calWeight += gapWeightOf(ownerOrd);
  }
  // Tokens per character, from this session when possible (≈0.25 = 4 chars/token
  // is the usual fallback).
  const tokensPerChar = calChars > 0 ? calWeight / calChars : 0.25;

  // Pass B — build each tool's weight. A lone tool in a turn takes that turn's
  // exact differenced weight; tools sharing a turn are each sized from their own
  // result (chars × the calibrated ratio), capped so a turn's tools never claim
  // more than the turn actually grew. Growth beyond the tools' outputs stays
  // unattributed — it isn't removable by unchecking a tool.
  const tools: SimTool[] = [];
  for (const p of tl) {
    if (p.kind !== "tool_use") continue;
    const ownerOrd = callAtOrBefore(p.i);
    const owner = ownerOrd >= 0 ? calls[ownerOrd] : undefined;
    const next = owner ? calls[owner.ord + 1] : undefined;
    const wall = wallById.get(p.i) ?? 0;

    let weight: number | null = null;
    let entry = -1;
    let exit = -1;
    let note: string | undefined;

    if (owner && next) {
      const gapWeight = gapWeightOf(ownerOrd);
      const siblings = toolsByGapCall.get(ownerOrd) ?? [];
      const mySize = outCharsById.get(p.i) ?? 0;
      if (siblings.length <= 1) {
        weight = gapWeight;
      } else {
        // Scale the size-based estimates so the turn's tools sum to at most the
        // real growth (they may be far less — the rest is non-tool context).
        const estSum = siblings.reduce((a, s) => a + (outCharsById.get(s.i) ?? 0) * tokensPerChar, 0);
        const scale = estSum > gapWeight && estSum > 0 ? gapWeight / estSum : 1;
        weight = mySize * tokensPerChar * scale;
        note = `estimated from this tool's ${mySize.toLocaleString()}-char output (turn ran ${siblings.length} tools)`;
      }
      entry = next.ord;
      exit = nextResetAfter(entry);
    } else {
      note = "no following API call — context weight not derivable";
    }

    tools.push({
      id: p.i,
      tool: p.tool || "tool",
      label: p.label || "",
      t: p.t,
      wall,
      weight,
      entry,
      exit,
      solo: 0, // filled in below, once all weights are known
      note,
    });
  }
  const toolByIdTmp = new Map(tools.map((t) => [t.id, t]));

  // Injection residual. A turn's exact growth (gapWeight) can far exceed what its
  // tool *results* carry: a Skill loads its body, a Task/Agent spawn folds in the
  // subagent's output, an MCP call can return or inject a large resource — yet
  // the tool_result recorded in the transcript is small. Attribute that
  // unexplained residual to the "injector" call(s) in the turn so unchecking one
  // removes the context it actually caused; otherwise this large, very real cost
  // is un-simulatable. A floor keeps ordinary size-estimate slack from being
  // dumped onto an injector, and turns with no injector leave the residual
  // unattributed (we can't tell what caused it — e.g. a pasted message).
  for (const [ownerOrd, sibs] of toolsByGapCall) {
    if (sibs.length <= 1) continue; // single-tool turns already carry exact weight
    const injectorSibs = sibs
      .map((s) => toolByIdTmp.get(s.i))
      .filter((t): t is SimTool => !!t && t.weight !== null && isInjector(t.tool));
    if (!injectorSibs.length) continue;
    const claimed = sibs.reduce((a, s) => a + (toolByIdTmp.get(s.i)?.weight ?? 0), 0);
    const residual = gapWeightOf(ownerOrd) - claimed;
    if (residual < RESIDUAL_FLOOR) continue;
    const share = residual / injectorSibs.length;
    for (const inj of injectorSibs) {
      inj.weight = (inj.weight ?? 0) + share;
      inj.note = `includes ~${Math.round(share).toLocaleString()} tokens of context this ${injectorKind(inj.tool)} added beyond its result`;
    }
  }

  // Recompute total cost given a set of excluded tool ids. Each excluded tool's
  // weight is removed from every call in [entry, exit); at each such call the
  // reduction is split across that call's cache-write / cache-read in proportion
  // to its actual cw:cr — so a cache-expiry re-write (cw spikes, cr collapses)
  // credits the 1.25× write savings, and a normal cached read credits 0.1×. The
  // proportional split also self-caps: the summed reductions can't exceed a
  // call's own cw/cr. This mirrors the browser's recompute exactly.
  const catalog = withCatalog(s.models);
  const recost = (excluded: Set<number>): number => {
    const dCW: number[] = new Array(calls.length).fill(0);
    const dCR: number[] = new Array(calls.length).fill(0);
    for (const t of tools) {
      if (t.weight === null || !excluded.has(t.id)) continue;
      for (let o = t.entry; o < t.exit; o++) {
        const c = calls[o]!;
        const denom = c.cw + c.cr;
        const ratio = denom > 0 ? c.cw / denom : 0;
        dCW[o]! += t.weight * ratio;
        dCR[o]! += t.weight * (1 - ratio);
      }
    }
    let cost = 0;
    for (const c of calls) {
      const cw = Math.max(0, c.cw - dCW[c.ord]!);
      const cr = Math.max(0, c.cr - dCR[c.ord]!);
      cost += costOf({ in: c.in, out: c.out, cw, cr }, c.model, catalog);
    }
    return cost;
  };
  const baseCost = recost(new Set());
  for (const t of tools) {
    if (t.weight !== null) t.solo = Math.max(0, baseCost - recost(new Set([t.id])));
  }

  const toolById = new Map(tools.map((t) => [t.id, t]));

  // Linear transcript rows. tool_result points fold into their tool_use row
  // (via wall-clock) so a checkbox toggles the call+result as one unit.
  const rows: Row[] = [];
  for (const p of tl) {
    if (p.kind === "tool_result") continue;
    if (p.kind === "assistant") {
      const call = calls.find((c) => c.i === p.i);
      rows.push({
        i: p.i,
        kind: p.kind,
        t: p.t,
        cls: "assistant",
        tag: "assistant",
        label: p.label || "",
        model: (p.model || "").replace(/^claude-/, ""),
        ctx: call ? ctxOf(call) : undefined,
      });
    } else if (p.kind === "tool_use") {
      const t = toolById.get(p.i)!;
      rows.push({
        i: p.i,
        kind: p.kind,
        t: p.t,
        cls: "tool",
        tag: t.tool,
        label: p.label || "",
        toolId: t.id,
        weight: t.weight,
        wall: t.wall,
        solo: t.solo,
        ...(t.note ? { note: t.note } : {}),
      });
    } else if (p.kind === "prompt") {
      rows.push({ i: p.i, kind: p.kind, t: p.t, cls: "prompt", tag: "you", label: p.label || "" });
    } else {
      // skill / notification / anything else — muted context rows.
      rows.push({ i: p.i, kind: p.kind, t: p.t, cls: "meta", tag: p.kind, label: p.label || "" });
    }
  }

  let subagentCost = 0;
  for (const [model, u] of Object.entries(s.subagentUsageByModel))
    subagentCost += costOf(u, model, withCatalog(s.models));

  return { calls, tools, rows, subagentCost, duration: s.durationSeconds || 0 };
}

// --- Row rendering ---

function truncate(text: string, n: number): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n) + "…" : one;
}

function renderRow(r: Row): string {
  const time = `<span class="r-time">T+${fmtOffset(r.t)}</span>`;
  const tag = `<span class="r-tag">${escape(r.tag)}</span>`;
  const preview = r.label ? `<span class="r-text">${escape(truncate(r.label, 200))}</span>` : "";

  if (r.cls === "tool") {
    const removable = r.weight !== null;
    const w = removable ? fmtTokens(r.weight!) : "—";
    const box = removable
      ? `<input type="checkbox" class="r-box" checked data-tool="${r.toolId}" data-weight="${r.weight}" data-wall="${r.wall}">`
      : `<input type="checkbox" class="r-box" disabled title="No following API call — impact not derivable">`;
    const approx = removable && !!r.note;
    const tokTitle = r.note
      ? `Context tokens this tool added, re-sent on every later API call — ${r.note}`
      : "Context tokens this tool added, re-sent on every later API call";
    const stats =
      `<span class="r-metric${approx ? " r-approx" : ""}" title="${attr(tokTitle)}">${w} tokens${approx ? "*" : ""}</span>` +
      (r.wall && r.wall > 0.05
        ? `<span class="r-metric" title="Wall-clock spent running this tool">${fmtOffset(r.wall)}</span>`
        : "") +
      (removable && r.solo! > 0
        ? `<span class="r-metric r-cost" title="Downstream cost of this tool alone">$${r.solo!.toFixed(3)}</span>`
        : "");
    return `<label class="row row-tool" data-tool-row="${r.toolId}">
  ${box}
  <span class="r-main">${time}${tag}${preview}</span>
  <span class="r-stats">${stats}</span>
</label>`;
  }

  if (r.cls === "assistant") {
    const model = r.model ? `<span class="r-model">${escape(r.model)}</span>` : "";
    const ctx =
      r.ctx !== undefined
        ? `<span class="r-metric" title="Context window in scope at this call">${fmtTokens(r.ctx)} tokens</span>`
        : "";
    return `<div class="row row-assistant">
  <span class="r-gutter"></span>
  <span class="r-main">${time}${tag}${model}${preview}</span>
  <span class="r-stats">${ctx}</span>
</div>`;
  }

  const cls = r.cls === "prompt" ? "row-prompt" : "row-meta";
  return `<div class="row ${cls}">
  <span class="r-gutter"></span>
  <span class="r-main">${time}${tag}${preview}</span>
  <span class="r-stats"></span>
</div>`;
}

// --- Page assembly ---

export function generateSimulationHtml(s: Sidecar): string {
  const sim = buildSim(s);
  const title = (s.title || "").trim() || "Untitled conversation";
  const removableCount = sim.tools.filter((t) => t.weight !== null).length;

  const rowsHtml = sim.rows.map(renderRow).join("\n");

  // Client payload: just the API calls, the removable tools, and constants. The
  // browser recomputes cost / peak-context / duration on every toggle.
  const payload = {
    calls: sim.calls.map((c) => ({
      o: c.ord,
      m: c.model,
      in: c.in,
      out: c.out,
      cw: c.cw,
      cr: c.cr,
    })),
    tools: sim.tools
      .filter((t) => t.weight !== null)
      .map((t) => ({ id: t.id, w: t.weight, e: t.entry, x: t.exit, wall: t.wall })),
    // Resolved USD-per-1M prices for exactly the models in this session, so the
    // client looks a model up instead of re-implementing resolution.
    costs: resolvedCosts(sim.calls.map((c) => c.model), withCatalog(s.models)),
    // Fallback for a model string that somehow isn't in the map above.
    def: resolveModel(DEFAULT_MODEL_ID, withCatalog(s.models)).cost,
    subagentCost: sim.subagentCost,
    duration: sim.duration,
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Simulation — ${escape((s.title || s.uuid).slice(0, 60))}</title>
<style>
:root {
  --bg: #0d1117; --surface: #161b22; --surface-2: #1c2128; --border: #30363d;
  --text: #e6edf3; --text-muted: #8b949e;
  --prompt: #3fb950; --assistant: #58a6ff; --tool: #d29922; --cost: #3fb950;
  --removed: #f85149;
  --radius: 10px;
  --mono: ui-monospace, SFMono-Regular, Menlo, monospace;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
  background: var(--bg); color: var(--text); line-height: 1.5;
}
.layout { display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: 24px; max-width: 1200px; margin: 0 auto; padding: 26px 18px 80px; align-items: start; }

/* Header */
.head { grid-column: 1 / -1; }
.eyebrow { font-family: var(--mono); font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--text-muted); }
.head h1 { font-size: clamp(19px, 2vw, 26px); line-height: 1.2; margin: 6px 0 10px; max-width: 46ch; letter-spacing: -0.02em; }
.chips { display: flex; gap: 8px; flex-wrap: wrap; }
.chips span { font-size: 12px; color: var(--text-muted); background: var(--surface-2); border: 1px solid var(--border); padding: 3px 9px; border-radius: 999px; }
.intro { margin-top: 12px; color: var(--text-muted); font-size: 13px; max-width: 78ch; line-height: 1.5; }

/* Transcript */
.transcript { display: grid; gap: 3px; }
.controls { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
.btn { background: var(--surface); border: 1px solid var(--border); color: var(--text); padding: 5px 11px; border-radius: 6px; cursor: pointer; font-size: 12px; }
.btn:hover { background: var(--surface-2); }
.row { display: grid; grid-template-columns: 22px minmax(0, 1fr) auto; align-items: baseline; gap: 10px; padding: 5px 10px; border: 1px solid transparent; border-radius: 8px; font-size: 13px; }
.row-tool { background: var(--surface); border-color: var(--border); cursor: pointer; }
.row-tool:hover { background: var(--surface-2); }
.row-assistant { opacity: 0.95; }
.row-prompt { background: rgba(63,185,80,0.08); border-color: rgba(63,185,80,0.25); }
.row-meta { opacity: 0.5; }
.r-gutter { width: 22px; }
.r-box { width: 15px; height: 15px; margin-top: 3px; accent-color: var(--tool); cursor: pointer; }
.r-main { min-width: 0; display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.r-time { font-family: var(--mono); font-size: 10px; color: var(--text-muted); flex: none; }
.r-tag { font-family: var(--mono); font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em; padding: 1px 6px; border-radius: 4px; flex: none; }
.row-prompt .r-tag { background: rgba(63,185,80,0.18); color: var(--prompt); }
.row-assistant .r-tag { background: rgba(88,166,255,0.16); color: var(--assistant); }
.row-tool .r-tag { background: rgba(210,153,34,0.18); color: var(--tool); }
.row-meta .r-tag { background: var(--surface-2); color: var(--text-muted); }
.r-model { font-family: var(--mono); font-size: 10px; color: var(--text-muted); flex: none; }
.r-text { color: var(--text); overflow: hidden; text-overflow: ellipsis; }
.row-meta .r-text, .row-assistant .r-text { color: var(--text-muted); }
.r-stats { display: flex; gap: 8px; align-items: baseline; flex: none; }
.r-metric { font-family: var(--mono); font-size: 10px; color: var(--text-muted); white-space: nowrap; }
.r-cost { color: var(--cost); }
.r-approx { color: var(--tool); cursor: help; }
/* A deselected tool: struck through, and its stats dimmed. */
.row-tool.removed { border-color: rgba(248,81,73,0.4); background: rgba(248,81,73,0.06); }
.row-tool.removed .r-text { text-decoration: line-through; color: var(--text-muted); }
.row-tool.removed .r-tag { opacity: 0.5; }

/* Side panel */
.panel { position: sticky; top: 22px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 18px; display: grid; gap: 16px; }
.panel h2 { font-size: 14px; letter-spacing: -0.01em; }
.panel .hint { font-size: 11px; color: var(--text-muted); line-height: 1.45; }
.metric { display: grid; gap: 3px; }
.metric .m-label { font-family: var(--mono); font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); }
.metric .m-row { display: flex; align-items: baseline; gap: 8px; }
.metric .m-base { font-size: 15px; color: var(--text-muted); }
.metric .m-arrow { color: var(--text-muted); font-size: 12px; }
.metric .m-sim { font-size: 22px; letter-spacing: -0.02em; }
.metric .m-delta { font-family: var(--mono); font-size: 11px; margin-left: auto; padding: 1px 7px; border-radius: 999px; background: var(--surface-2); color: var(--text-muted); }
.metric.changed .m-delta { background: rgba(248,81,73,0.16); color: #ff9d95; }
.metric.changed .m-sim { color: #7ee787; }
.summary { border-top: 1px solid var(--border); padding-top: 14px; font-size: 12px; color: var(--text-muted); }
.summary strong { color: var(--text); }
.reset-line { border-top: 1px solid var(--border); padding-top: 12px; }
.reset-line .btn { width: 100%; }

@media (max-width: 860px) {
  .layout { grid-template-columns: 1fr; }
  .panel { position: static; }
}
</style>
</head>
<body>
<main class="layout">
  <header class="head">
    <div class="eyebrow">Conversation simulation</div>
    <h1>${escape(title.length > 160 ? title.slice(0, 160) + "…" : title)}</h1>
    <div class="chips">
      <span>${escape(s.branch || "")}</span>
      <span>${escape(s.cwd || "")}</span>
      <span>${removableCount} removable tool call(s)</span>
    </div>
    <p class="intro">Uncheck a tool call to simulate never having run it. Its result stops
    riding along in every later prompt, so the panel on the right recomputes the
    session's cost, peak context and duration. This is an accounting model over the
    real token usage — it assumes the same conversation, only cheaper; it does not
    predict how the agent would have behaved without the result. A lone tool in a turn
    gets that turn's exact context growth; a
    <span class="r-approx">tokens*</span> marks a tool that shared its turn with
    others — it is sized from its own result length, so the figure is an estimate,
    and context a turn gained from things a tool result doesn't carry (skill or
    system injection, pasted text) is left unattributed.</p>
  </header>

  <section class="transcript-wrap">
    <div class="controls">
      <button class="btn" id="all-on" type="button">Keep all</button>
      <button class="btn" id="all-off" type="button">Remove all tools</button>
      <button class="btn" id="reads-off" type="button">Remove all Reads</button>
    </div>
    <div class="transcript">
${rowsHtml}
    </div>
  </section>

  <aside class="panel">
    <h2>Simulated impact</h2>
    <p class="hint">Baseline → simulated. Δ is what unchecking has removed.</p>
    <div class="metric" id="m-cost">
      <span class="m-label">Total cost</span>
      <div class="m-row"><span class="m-base"></span><span class="m-arrow">→</span><span class="m-sim"></span><span class="m-delta"></span></div>
    </div>
    <div class="metric" id="m-ctx">
      <span class="m-label">Peak context</span>
      <div class="m-row"><span class="m-base"></span><span class="m-arrow">→</span><span class="m-sim"></span><span class="m-delta"></span></div>
    </div>
    <div class="metric" id="m-dur">
      <span class="m-label">Tool wall-clock removed</span>
      <div class="m-row"><span class="m-base"></span><span class="m-arrow">→</span><span class="m-sim"></span><span class="m-delta"></span></div>
    </div>
    <div class="summary" id="summary"></div>
    <div class="reset-line"><button class="btn" id="reset" type="button">Reset simulation</button></div>
  </aside>
</main>

<script id="sim-data" type="application/json">${JSON.stringify(payload).replace(/</g, "\\u003c")}</script>
<script>
(function () {
  var DATA = JSON.parse(document.getElementById('sim-data').textContent);
  var CALLS = DATA.calls, TOOLS = DATA.tools;
  var toolById = {}; TOOLS.forEach(function (t) { toolById[t.id] = t; });

  function costOf(u, model) {
    var p = DATA.costs[model] || DATA.def;
    return (u.in * p.input + u.out * p.output + u.cw * p.cache_write + u.cr * p.cache_read) / 1e6;
  }

  // Recompute totals given a Set of excluded tool ids. Each excluded tool's
  // weight is removed from every call in [entry, exit), split across that call's
  // cache-write / cache-read in proportion to its actual cw:cr (see the server
  // comment on the server recost fn). Keyed by call ordinal = array index.
  function recompute(excluded) {
    var dCW = {}, dCR = {};
    TOOLS.forEach(function (t) {
      if (!excluded.has(t.id)) return;
      for (var o = t.e; o < t.x; o++) {
        var c = CALLS[o];
        var denom = c.cw + c.cr;
        var ratio = denom > 0 ? c.cw / denom : 0;
        dCW[o] = (dCW[o] || 0) + t.w * ratio;
        dCR[o] = (dCR[o] || 0) + t.w * (1 - ratio);
      }
    });
    var cost = 0, peak = 0;
    CALLS.forEach(function (c) {
      var cw = Math.max(0, c.cw - (dCW[c.o] || 0));
      var cr = Math.max(0, c.cr - (dCR[c.o] || 0));
      cost += costOf({ in: c.in, out: c.out, cw: cw, cr: cr }, c.m);
      var ctx = c.in + cw + cr;
      if (ctx > peak) peak = ctx;
    });
    cost += DATA.subagentCost;
    var wall = 0;
    excluded.forEach(function (id) { if (toolById[id]) wall += toolById[id].wall; });
    return { cost: cost, peak: peak, wall: wall };
  }

  function fmtMoney(n) { return '$' + n.toFixed(2); }
  function fmtTokens(n) {
    if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
    return String(Math.round(n));
  }
  function fmtDur(sec) {
    var s = Math.round(sec);
    if (s < 60) return s + 's';
    var m = Math.floor(s / 60); var r = s % 60;
    if (m < 60) return m + 'm ' + r + 's';
    return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
  }

  var boxes = Array.prototype.slice.call(document.querySelectorAll('.r-box:not([disabled])'));
  var baseline = recompute(new Set());
  var baseDurSim = DATA.duration;

  function excludedSet() {
    var s = new Set();
    boxes.forEach(function (b) { if (!b.checked) s.add(parseInt(b.getAttribute('data-tool'), 10)); });
    return s;
  }

  function setMetric(id, baseStr, simStr, changed, deltaStr) {
    var el = document.getElementById(id);
    el.querySelector('.m-base').textContent = baseStr;
    el.querySelector('.m-sim').textContent = simStr;
    el.querySelector('.m-delta').textContent = deltaStr;
    el.classList.toggle('changed', changed);
  }

  function render() {
    var ex = excludedSet();
    var sim = recompute(ex);
    var costChanged = Math.abs(sim.cost - baseline.cost) > 1e-9;
    var ctxChanged = sim.peak !== baseline.peak;
    var durChanged = sim.wall > 0;

    setMetric('m-cost', fmtMoney(baseline.cost), fmtMoney(sim.cost), costChanged,
      costChanged ? '−' + fmtMoney(baseline.cost - sim.cost) : '—');
    setMetric('m-ctx', fmtTokens(baseline.peak), fmtTokens(sim.peak), ctxChanged,
      ctxChanged ? '−' + fmtTokens(baseline.peak - sim.peak) : '—');
    setMetric('m-dur', fmtDur(baseDurSim), fmtDur(Math.max(0, baseDurSim - sim.wall)), durChanged,
      durChanged ? '−' + fmtDur(sim.wall) : '—');

    var n = ex.size;
    var pctCost = baseline.cost > 0 ? ((baseline.cost - sim.cost) / baseline.cost * 100) : 0;
    document.getElementById('summary').innerHTML =
      n === 0
        ? 'No tools removed — showing the session as it happened.'
        : '<strong>' + n + '</strong> tool call(s) removed · <strong>' + pctCost.toFixed(1) +
          '%</strong> of total cost saved.';

    // Row styling.
    boxes.forEach(function (b) {
      var row = document.querySelector('[data-tool-row="' + b.getAttribute('data-tool') + '"]');
      if (row) row.classList.toggle('removed', !b.checked);
    });
  }

  boxes.forEach(function (b) { b.addEventListener('change', render); });
  // Prevent the wrapping <label> from double-toggling when the box itself is hit.
  document.querySelectorAll('.row-tool').forEach(function (row) {
    row.addEventListener('click', function (e) { if (e.target.classList.contains('r-box')) e.stopPropagation(); });
  });

  document.getElementById('all-on').addEventListener('click', function () {
    boxes.forEach(function (b) { b.checked = true; }); render();
  });
  document.getElementById('all-off').addEventListener('click', function () {
    boxes.forEach(function (b) { b.checked = false; }); render();
  });
  document.getElementById('reset').addEventListener('click', function () {
    boxes.forEach(function (b) { b.checked = true; }); render();
  });
  document.getElementById('reads-off').addEventListener('click', function () {
    boxes.forEach(function (b) {
      var row = document.querySelector('[data-tool-row="' + b.getAttribute('data-tool') + '"]');
      var tag = row && row.querySelector('.r-tag');
      if (tag && tag.textContent.toLowerCase() === 'read') b.checked = false;
    });
    render();
  });

  render();
})();
</script>
</body>
</html>`;
}

// --- CLI (standalone: render a sidecar .json to a .html) ---

function main(): void {
  const input = process.argv[2];
  if (!input) {
    console.error("Usage: generate-simulation <sidecar.json> [output.html]");
    process.exit(1);
  }
  const sidecar: Sidecar = JSON.parse(fs.readFileSync(input, "utf-8"));
  const output = process.argv[3] || input.replace(/\.json$/, "-simulation.html");
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, generateSimulationHtml(sidecar), "utf-8");
  console.log(`Generated: ${output}`);
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === `file://${path.resolve(process.argv[1])}`;
if (invokedDirectly) main();
