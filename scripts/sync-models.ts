#!/usr/bin/env tsx
// sync-models — print a refreshed `MODELS` literal for `src/models.ts`.
//
// Reads the models.dev catalog OpenCode caches at
// `$XDG_CACHE_HOME/opencode/models.json` (or fetches it when `--fetch` is
// passed) and prints the entries for the requested providers in the exact shape
// `src/models.ts` uses. The checked-in catalog stays authoritative — this only
// produces text for a human to review and paste, so exports remain reproducible
// on machines with no OpenCode installed.
//
//   npm run sync-models                  # anthropic, from the local cache
//   npm run sync-models -- anthropic openai
//   npm run sync-models -- --fetch anthropic

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

interface RawModel {
  name?: string;
  family?: string;
  limit?: { context?: number; output?: number };
  cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number };
}

const args = process.argv.slice(2);
const doFetch = args.includes("--fetch");
const providers = args.filter((a) => !a.startsWith("--"));
const wanted = providers.length ? providers : ["anthropic"];

const cacheFile = path.join(
  process.env["XDG_CACHE_HOME"] ?? path.join(os.homedir(), ".cache"),
  "opencode",
  "models.json",
);

async function loadCatalog(): Promise<Record<string, { models?: Record<string, RawModel> }>> {
  if (doFetch) {
    const res = await fetch("https://models.dev/api.json");
    if (!res.ok) throw new Error(`models.dev returned ${res.status}`);
    return (await res.json()) as Record<string, { models?: Record<string, RawModel> }>;
  }
  if (!fs.existsSync(cacheFile)) {
    throw new Error(
      `No local catalog at ${cacheFile}. Install OpenCode, or re-run with --fetch to read models.dev directly.`,
    );
  }
  return JSON.parse(fs.readFileSync(cacheFile, "utf-8"));
}

function num(n: number): string {
  return n >= 1000 && Number.isInteger(n)
    ? n.toLocaleString("en-US").replace(/,/g, "_")
    : String(n);
}

const catalog = await loadCatalog();

for (const provider of wanted) {
  const models = catalog[provider]?.models;
  if (!models) {
    console.error(`// ${provider}: not present in the catalog`);
    continue;
  }
  console.log(`  // ${provider}, copied from models.dev.`);
  for (const [id, m] of Object.entries(models)) {
    if (!m.cost || !m.limit) continue;
    console.log(`  ${JSON.stringify(id)}: {
    id: ${JSON.stringify(id)},
    name: ${JSON.stringify(m.name ?? id)},
    family: ${JSON.stringify(m.family ?? id)},
    limit: { context: ${num(m.limit.context ?? 0)}, output: ${num(m.limit.output ?? 0)} },
    cost: { input: ${m.cost.input ?? 0}, output: ${m.cost.output ?? 0}, cache_read: ${m.cost.cache_read ?? 0}, cache_write: ${m.cost.cache_write ?? 0} },
  },`);
  }
}
