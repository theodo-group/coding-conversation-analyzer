// sources/models-dev — read the models.dev catalog OpenCode caches on disk.
//
// Shared by the adapters whose sessions run on models the checked-in catalog
// (`models.ts`) doesn't cover: OpenCode, and GitHub Copilot CLI, which
// models.dev lists as its own `github-copilot` provider keyed by Copilot's model
// ids. Entries found here ride along in the export's sidecar, so the reports
// price them without the checked-in catalog having to know every provider.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { ModelEntry } from "../models.ts";

// Where OpenCode keeps the catalog: `$XDG_CACHE_HOME/opencode/models.json`,
// defaulting to `~/.cache`.
export function defaultModelsDevFile(): string {
  const xdg = process.env["XDG_CACHE_HOME"];
  const cacheRoot = xdg ? xdg.replace(/^~(?=$|\/)/, os.homedir()) : path.join(os.homedir(), ".cache");
  return path.join(cacheRoot, "opencode", "models.json");
}

// Read lazily and only for the models a session actually used, so a 4.5 MB
// file isn't parsed per export when every model is already in the built-in
// catalog.
export class ModelsDevCache {
  private loaded = false;
  private byProvider: Record<string, { models?: Record<string, Partial<ModelEntry>> }> = {};

  constructor(private readonly file: string) {}

  lookup(providerID: string, modelID: string): ModelEntry | undefined {
    if (!this.loaded) {
      this.loaded = true;
      try {
        this.byProvider = JSON.parse(fs.readFileSync(this.file, "utf-8"));
      } catch {
        this.byProvider = {};
      }
    }
    const m = this.byProvider[providerID]?.models?.[modelID];
    if (!m || !m.cost || !m.limit) return undefined;
    return {
      id: modelID,
      name: m.name ?? modelID,
      family: m.family ?? `${providerID}/${modelID}`,
      limit: m.limit,
      cost: m.cost,
    };
  }
}
