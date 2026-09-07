// models — the single price/limit catalog for every model the reports price.
//
// The entries use the models.dev field names verbatim (`limit.{context,output}`,
// `cost.{input,output,cache_read,cache_write}` in USD per 1M tokens), which is
// also the shape OpenCode ships at `~/.cache/opencode/models.json`. Entries can
// therefore be copied between the two in either direction, and refreshed from
// upstream without reshaping anything.
//
// The checked-in catalog is authoritative so exports stay reproducible on
// machines with no OpenCode installed. Models from other providers ride along in
// the export's sidecar (`Sidecar.models`, keyed `<provider>/<model>`) and are
// merged in at render time via `withCatalog()`.

export interface ModelCost {
  input: number; // USD per 1M tokens
  output: number;
  cache_read: number;
  cache_write: number;
}

export interface ModelLimit {
  context: number;
  output: number;
}

export interface ModelEntry {
  id: string;
  name: string;
  family: string;
  limit: ModelLimit;
  cost: ModelCost;
}

export type ModelCatalog = Record<string, ModelEntry>;

// Anthropic, copied from models.dev.
export const MODELS: ModelCatalog = {
  "claude-opus-5": {
    id: "claude-opus-5",
    name: "Claude Opus 5",
    family: "claude-opus",
    limit: { context: 1_000_000, output: 128_000 },
    cost: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
  },
  "claude-opus-4-8": {
    id: "claude-opus-4-8",
    name: "Claude Opus 4.8",
    family: "claude-opus",
    limit: { context: 1_000_000, output: 128_000 },
    cost: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
  },
  "claude-opus-4-7": {
    id: "claude-opus-4-7",
    name: "Claude Opus 4.7",
    family: "claude-opus",
    limit: { context: 1_000_000, output: 128_000 },
    cost: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
  },
  "claude-opus-4-6": {
    id: "claude-opus-4-6",
    name: "Claude Opus 4.6",
    family: "claude-opus",
    limit: { context: 1_000_000, output: 128_000 },
    cost: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
  },
  "claude-opus-4-5": {
    id: "claude-opus-4-5",
    name: "Claude Opus 4.5 (latest)",
    family: "claude-opus",
    limit: { context: 200_000, output: 64_000 },
    cost: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
  },
  "claude-opus-4-5-20251101": {
    id: "claude-opus-4-5-20251101",
    name: "Claude Opus 4.5",
    family: "claude-opus",
    limit: { context: 200_000, output: 64_000 },
    cost: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
  },
  "claude-sonnet-5": {
    id: "claude-sonnet-5",
    name: "Claude Sonnet 5",
    family: "claude-sonnet",
    limit: { context: 1_000_000, output: 128_000 },
    cost: { input: 2, output: 10, cache_read: 0.2, cache_write: 2.5 },
  },
  "claude-sonnet-4-6": {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    family: "claude-sonnet",
    limit: { context: 1_000_000, output: 128_000 },
    cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
  },
  "claude-sonnet-4-5": {
    id: "claude-sonnet-4-5",
    name: "Claude Sonnet 4.5 (latest)",
    family: "claude-sonnet",
    limit: { context: 1_000_000, output: 64_000 },
    cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
  },
  "claude-sonnet-4-5-20250929": {
    id: "claude-sonnet-4-5-20250929",
    name: "Claude Sonnet 4.5",
    family: "claude-sonnet",
    limit: { context: 1_000_000, output: 64_000 },
    cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
  },
  "claude-haiku-4-5": {
    id: "claude-haiku-4-5",
    name: "Claude Haiku 4.5 (latest)",
    family: "claude-haiku",
    limit: { context: 200_000, output: 64_000 },
    cost: { input: 1, output: 5, cache_read: 0.1, cache_write: 1.25 },
  },
  "claude-haiku-4-5-20251001": {
    id: "claude-haiku-4-5-20251001",
    name: "Claude Haiku 4.5",
    family: "claude-haiku",
    limit: { context: 200_000, output: 64_000 },
    cost: { input: 1, output: 5, cache_read: 0.1, cache_write: 1.25 },
  },
  "claude-fable-5-1": {
    id: "claude-fable-5-1",
    name: "Claude Fable 5.1",
    family: "claude-fable",
    limit: { context: 1_000_000, output: 128_000 },
    cost: { input: 10, output: 50, cache_read: 0.25, cache_write: 12.5 },
  },
  "claude-fable-5": {
    id: "claude-fable-5",
    name: "Claude Fable 5",
    family: "claude-fable",
    limit: { context: 1_000_000, output: 128_000 },
    cost: { input: 10, output: 50, cache_read: 1, cache_write: 12.5 },
  },
  // Local-only entry: Claude Code writes this literal model id for messages it
  // synthesises itself (no API call, no charge).
  "<synthetic>": {
    id: "<synthetic>",
    name: "Synthetic",
    family: "synthetic",
    limit: { context: 1_000_000, output: 128_000 },
    cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
  },
};

export const DEFAULT_MODEL_ID = "claude-opus-5";

// Ordered family fallback for ids the catalog has never seen — matched by
// substring, most specific first.
const FAMILY_FALLBACK: Array<{ match: string; id: string }> = [
  { match: "fable", id: "claude-fable-5-1" },
  { match: "mythos", id: "claude-fable-5-1" },
  { match: "opus", id: "claude-opus-5" },
  { match: "sonnet", id: "claude-sonnet-5" },
  { match: "haiku", id: "claude-haiku-4-5" },
];

// Merge per-export catalog entries (other providers, from the sidecar) over the
// built-in one. Returns a new object; neither input is mutated.
export function withCatalog(extra?: ModelCatalog | null): ModelCatalog {
  if (!extra) return MODELS;
  return { ...MODELS, ...extra };
}

// Resolve an arbitrary model string to a catalog entry:
//   1. exact id
//   2. id minus a trailing variant suffix (`claude-opus-5[1m]` → `claude-opus-5`)
//   3. bare model id after a `<provider>/` prefix, then (1)+(2) again
//   4. ordered family fallback by substring
//   5. DEFAULT_MODEL_ID
export function resolveModel(model: string, catalog: ModelCatalog = MODELS): ModelEntry {
  const direct = lookup(model, catalog);
  if (direct) return direct;

  const slash = model.indexOf("/");
  if (slash !== -1) {
    const bare = lookup(model.slice(slash + 1), catalog);
    if (bare) return bare;
  }

  const lower = model.toLowerCase();
  for (const f of FAMILY_FALLBACK) {
    if (lower.includes(f.match)) {
      const hit = catalog[f.id] ?? MODELS[f.id];
      if (hit) return hit;
    }
  }
  return catalog[DEFAULT_MODEL_ID] ?? MODELS[DEFAULT_MODEL_ID]!;
}

function lookup(id: string, catalog: ModelCatalog): ModelEntry | undefined {
  return catalog[id] ?? catalog[id.replace(/\[[^\]]*\]$/, "")];
}

export interface TokenUsage {
  in: number;
  out: number;
  cw: number; // cache write (creation)
  cr: number; // cache read
}

// Cost in USD for one call's usage. Cache prices come from the catalog rather
// than being derived from the input price — the ratio does not hold for every
// model (claude-fable-5-1 reads at 0.25, not 0.1 × input).
export function costOf(u: TokenUsage, model: string, catalog: ModelCatalog = MODELS): number {
  const c = resolveModel(model, catalog).cost;
  return (
    (u.in * c.input + u.out * c.output + u.cw * c.cache_write + u.cr * c.cache_read) / 1_000_000
  );
}

// Largest context window across the models a session actually used — the y-axis
// ceiling for the context-window chart.
export function contextLimitOf(models: string[], catalog: ModelCatalog = MODELS): number {
  let max = 0;
  for (const m of models) max = Math.max(max, resolveModel(m, catalog).limit.context);
  return max || (catalog[DEFAULT_MODEL_ID] ?? MODELS[DEFAULT_MODEL_ID]!).limit.context;
}

// A model → price map covering only the models given, for shipping to the
// browser (the simulator re-prices client-side). Keyed by the caller's own model
// strings so the client can do a plain lookup with no matching logic.
export function resolvedCosts(
  models: string[],
  catalog: ModelCatalog = MODELS,
): Record<string, ModelCost> {
  const out: Record<string, ModelCost> = {};
  for (const m of models) out[m] = resolveModel(m, catalog).cost;
  return out;
}
