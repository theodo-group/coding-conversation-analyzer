// sources/opencode — read OpenCode sessions into the neutral intermediate.
//
// OpenCode keeps everything in one SQLite database
// (`$XDG_DATA_HOME/opencode/opencode.db`), which we open read-only through
// Node's built-in `node:sqlite` — no new dependencies, and safe to read while
// OpenCode is running (WAL mode). The alternatives were rejected: `opencode
// export` spawns a whole runtime per session and its `session list` is
// cwd-scoped and hides child sessions, so enumerating a project means reading
// the database anyway.
//
// Everything OpenCode-specific is resolved here: its lowercase tool names and
// camelCase tool inputs are mapped onto the canonical ones, assistant messages
// are split per API step, and child sessions become subagent transcripts.

import { execSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { DatabaseSync } from "node:sqlite";
import { MODELS, type ModelCatalog, type ModelEntry } from "../models.ts";
import { openDatabase } from "./sqlite.ts";
import type {
  NeutralBlock,
  NeutralConversation,
  NeutralMessage,
  NeutralSession,
  NeutralTranscript,
  SetupItem,
  SourceAdapter,
  SourceSessionRef,
  Usage,
} from "./types.ts";

// --- Row shapes ---

interface SessionRow {
  id: string;
  project_id: string;
  parent_id: string | null;
  directory: string;
  title: string;
  version: string;
  agent: string | null;
  model: string | null;
  time_created: number;
  time_updated: number;
}

interface MessageRow {
  id: string;
  time_created: number;
  data: string;
}

interface PartRow {
  id: string;
  message_id: string;
  time_created: number;
  data: string;
}

interface OcTokens {
  input?: number;
  output?: number;
  reasoning?: number;
  cache?: { write?: number; read?: number };
}

interface OcMessage {
  role?: string;
  mode?: string;
  agent?: string;
  modelID?: string;
  providerID?: string;
  model?: { modelID?: string; providerID?: string };
  tokens?: OcTokens;
  time?: { created?: number; completed?: number };
}

interface OcToolState {
  status?: string;
  input?: Record<string, unknown>;
  output?: string;
  error?: string;
  title?: string;
  metadata?: Record<string, unknown>;
  time?: { start?: number; end?: number };
}

interface OcPart {
  type?: string;
  text?: string;
  synthetic?: boolean;
  tool?: string;
  callID?: string;
  state?: OcToolState;
  snapshot?: string;
  tokens?: OcTokens;
  time?: { start?: number; end?: number };
  auto?: boolean;
  overflow?: boolean;
}

// --- Tool mapping (§5.2 / §5.3) ---

// OpenCode's lowercase tool names → the canonical names the exporter formats
// and buckets against. The source name is kept as the display name so the
// transcript still reads like the session the user ran.
const TOOL_MAP: Record<string, string> = {
  read: "Read",
  list: "Read",
  glob: "Glob",
  grep: "Grep",
  bash: "Bash",
  edit: "Edit",
  patch: "Edit",
  write: "Write",
  task: "Agent",
  todowrite: "TodoWrite",
  webfetch: "WebFetch",
};

// OpenCode's camelCase tool inputs → the canonical snake_case keys, so the
// shared `formatToolInput` renders real diffs and code blocks instead of
// falling through to a raw JSON dump.
function normalizeInput(
  ocTool: string,
  canonical: string,
  input: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const i = input ?? {};
  switch (canonical) {
    case "Read":
      return {
        // `list` names its target `path`; `read` uses `filePath`.
        file_path: i["filePath"] ?? i["path"] ?? "",
        ...(i["offset"] !== undefined ? { offset: i["offset"] } : {}),
        ...(i["limit"] !== undefined ? { limit: i["limit"] } : {}),
      };
    case "Glob":
      return { pattern: i["pattern"] ?? "", ...(i["path"] ? { path: i["path"] } : {}) };
    case "Grep":
      return { pattern: i["pattern"] ?? "", ...(i["path"] ? { path: i["path"] } : {}) };
    case "Bash":
      return {
        command: i["command"] ?? "",
        ...(i["description"] ? { description: i["description"] } : {}),
      };
    case "Edit":
      return {
        file_path: i["filePath"] ?? i["file_path"] ?? "",
        old_string: i["oldString"] ?? i["old_string"] ?? "",
        new_string: i["newString"] ?? i["new_string"] ?? "",
      };
    case "Write":
      return { file_path: i["filePath"] ?? "", content: i["content"] ?? "" };
    case "Agent":
      // `task` already uses the canonical `description` / `prompt` /
      // `subagent_type` keys.
      return { ...i };
    default:
      // Unmapped tools render as a JSON dump; keep the source's own shape.
      return { ...i, ...(ocTool ? {} : {}) };
  }
}

// --- Model catalog ---

// models.dev catalog OpenCode ships in its cache. Read lazily and only for the
// models a session actually used, so a 4.5 MB file isn't parsed per export when
// every model is already in the built-in catalog.
class ModelsDevCache {
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

// --- Adapter ---

export interface OpenCodeAdapterOptions {
  projectRoot: string;
  // Overrides the XDG data dir (mirrors `--claude-dir`).
  dataDir?: string;
  cacheDir?: string;
}

// Columns this reader depends on. The database schema is internal to OpenCode
// and unversioned, so check it up front and fail loudly rather than silently
// exporting a half-empty conversation after an upstream change.
const REQUIRED_COLUMNS: Record<string, string[]> = {
  project: ["id", "worktree"],
  project_directory: ["project_id", "directory"],
  session: [
    "id",
    "project_id",
    "parent_id",
    "directory",
    "title",
    "version",
    "agent",
    "model",
    "time_created",
    "time_updated",
  ],
  message: ["id", "session_id", "time_created", "data"],
  part: ["id", "message_id", "session_id", "time_created", "data"],
};

function expandHome(p: string): string {
  return path.resolve(p.replace(/^~(?=$|\/)/, os.homedir()));
}

export class OpenCodeAdapter implements SourceAdapter {
  readonly source = "opencode" as const;
  readonly origin: string;

  private readonly db: DatabaseSync;
  private readonly opts: OpenCodeAdapterOptions;
  private readonly catalog: ModelsDevCache;
  private readonly projectIds: string[];
  // Branch is resolved once per adapter: it comes from the working tree, not
  // from anything OpenCode recorded (see `resolveBranch`).
  private branchCache = new Map<string, { branch: string; source: "live-git" | "unknown" }>();

  constructor(opts: OpenCodeAdapterOptions) {
    this.opts = opts;
    const dataDir = opts.dataDir
      ? expandHome(opts.dataDir)
      : path.join(
          process.env["XDG_DATA_HOME"]
            ? expandHome(process.env["XDG_DATA_HOME"])
            : path.join(os.homedir(), ".local", "share"),
          "opencode",
        );
    const dbPath = path.join(dataDir, "opencode.db");
    this.origin = dbPath;
    if (!fs.existsSync(dbPath)) {
      throw new Error(`OpenCode database not found: ${dbPath}`);
    }
    this.db = openDatabase(dbPath);
    this.assertSchema();

    const cacheDir = opts.cacheDir
      ? expandHome(opts.cacheDir)
      : path.join(
          process.env["XDG_CACHE_HOME"]
            ? expandHome(process.env["XDG_CACHE_HOME"])
            : path.join(os.homedir(), ".cache"),
          "opencode",
        );
    this.catalog = new ModelsDevCache(path.join(cacheDir, "models.json"));
    this.projectIds = this.findProjectIds(opts.projectRoot);
  }

  private assertSchema(): void {
    for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
      let cols: string[];
      try {
        cols = (this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
          (r) => r.name,
        );
      } catch (e) {
        throw new Error(`OpenCode database: cannot read table ${table} (${e})`);
      }
      if (!cols.length) {
        throw new Error(
          `OpenCode database schema has diverged: table '${table}' is missing. ` +
            `This exporter was written against opencode 1.18.x.`,
        );
      }
      const missing = columns.filter((c) => !cols.includes(c));
      if (missing.length) {
        throw new Error(
          `OpenCode database schema has diverged: ${table} is missing ${missing.join(", ")}. ` +
            `This exporter was written against opencode 1.18.x.`,
        );
      }
    }
  }

  // A project is keyed by its worktree; worktrees and sandboxes of the same
  // project are additionally listed in `project_directory`.
  private findProjectIds(root: string): string[] {
    const ids = new Set<string>();
    for (const r of this.db.prepare("SELECT id FROM project WHERE worktree = ?").all(root) as Array<{
      id: string;
    }>) {
      ids.add(r.id);
    }
    for (const r of this.db
      .prepare("SELECT project_id FROM project_directory WHERE directory = ?")
      .all(root) as Array<{ project_id: string }>) {
      ids.add(r.project_id);
    }
    return [...ids];
  }

  private sessionsWhere(clause: string, params: string[]): SessionRow[] {
    if (!this.projectIds.length) return [];
    const holes = this.projectIds.map(() => "?").join(",");
    return this.db
      .prepare(
        `SELECT id, project_id, parent_id, directory, title, version, agent, model,
                time_created, time_updated
         FROM session WHERE project_id IN (${holes}) AND ${clause}`,
      )
      .all(...this.projectIds, ...params) as unknown as SessionRow[];
  }

  private childrenOf(parentId: string): SessionRow[] {
    return this.sessionsWhere("parent_id = ?", [parentId]).sort(
      (a, b) => a.time_created - b.time_created,
    );
  }

  // Every descendant of a session, breadth-first. Nesting can be deeper than one
  // level — an OpenCode subagent can itself spawn subagents.
  private descendantsOf(rootId: string): SessionRow[] {
    const out: SessionRow[] = [];
    const queue = [rootId];
    const seen = new Set<string>([rootId]);
    while (queue.length) {
      for (const child of this.childrenOf(queue.shift()!)) {
        if (seen.has(child.id)) continue;
        seen.add(child.id);
        out.push(child);
        queue.push(child.id);
      }
    }
    return out;
  }

  list(): SourceSessionRef[] {
    return this.sessionsWhere("parent_id IS NULL", [])
      .sort((a, b) => a.time_created - b.time_created)
      .map((s) => ({
        uuid: s.id,
        // `ses_` prefix stripped; the remainder is mixed-case base62, so the
        // stem is tagged `oc` to stay unambiguous next to Claude's hex ids.
        prefix: "oc" + s.id.replace(/^ses_/, "").slice(0, 8),
        // A session's tree is only as fresh as its newest descendant: a running
        // subagent updates while the parent's own timestamp stays put.
        mtime: Math.max(
          s.time_updated,
          ...this.descendantsOf(s.id).map((d) => d.time_updated),
          0,
        ),
      }));
  }

  load(ref: SourceSessionRef): NeutralConversation {
    const rows = this.sessionsWhere("id = ?", [ref.uuid]);
    const row = rows[0];
    if (!row) throw new Error(`OpenCode session not found: ${ref.uuid}`);

    const session = this.buildSession(row);
    const subagents: NeutralTranscript[] = this.descendantsOf(row.id).map((child) => ({
      id: child.id,
      session: this.buildSession(child),
    }));
    // OpenCode has no workflow concept — the tier is simply never created.
    return { session, subagents, workflows: [] };
  }

  // OpenCode records no branch anywhere: `session.directory` and
  // `project.worktree` are paths, the `workspace` table (which has a `branch`
  // column) is unused, and the shadow snapshot repo's HEAD is an unborn
  // `refs/heads/main` default with no refs — it does not name the real branch.
  // So read the working tree's branch now and record that it is a *current*
  // reading, not the branch at session time.
  private resolveBranch(dir: string): { branch: string; source: "live-git" | "unknown" } {
    const cached = this.branchCache.get(dir);
    if (cached) return cached;
    let result: { branch: string; source: "live-git" | "unknown" } = {
      branch: "unknown",
      source: "unknown",
    };
    try {
      const b = execSync("git rev-parse --abbrev-ref HEAD", {
        cwd: dir,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      if (b && b !== "HEAD") result = { branch: b, source: "live-git" };
    } catch {
      /* not a git worktree any more, or gone entirely */
    }
    this.branchCache.set(dir, result);
    return result;
  }

  private buildSession(row: SessionRow): NeutralSession {
    const messages = this.db
      .prepare("SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created, id")
      .all(row.id) as unknown as MessageRow[];
    const parts = this.db
      .prepare("SELECT id, message_id, time_created, data FROM part WHERE session_id = ? ORDER BY id")
      .all(row.id) as unknown as PartRow[];

    const partsByMessage = new Map<string, PartRow[]>();
    for (const p of parts) {
      (partsByMessage.get(p.message_id) ?? partsByMessage.set(p.message_id, []).get(p.message_id)!).push(p);
    }

    const out: NeutralMessage[] = [];
    const models: ModelCatalog = {};
    const modeTransitions: Array<{ t: number; mode: string }> = [];
    const startMs = row.time_created;
    const iso = (ms: number) => new Date(ms).toISOString();

    for (const m of messages) {
      let data: OcMessage;
      try {
        data = JSON.parse(m.data);
      } catch {
        continue;
      }
      const mine = partsByMessage.get(m.id) ?? [];
      const providerID = data.providerID ?? data.model?.providerID ?? "";
      const modelID = data.modelID ?? data.model?.modelID ?? "";
      const model = providerID && modelID ? `${providerID}/${modelID}` : modelID || undefined;
      if (providerID && modelID) this.recordModel(models, providerID, modelID);

      // The band shows the agent/mode the session was in — the nearest thing
      // OpenCode has to Claude Code's permission mode (they are not the same
      // thing; the dashboard labels them differently).
      const mode = data.mode ?? data.agent;
      if (mode) {
        const prev = modeTransitions[modeTransitions.length - 1];
        if (!prev || prev.mode !== mode) {
          modeTransitions.push({ t: (m.time_created - startMs) / 1000, mode });
        }
      }

      if (data.role === "assistant") {
        out.push(...this.assistantMessages(mine, m, model, mode, iso));
      } else {
        const blocks: NeutralBlock[] = [];
        for (const p of mine) {
          const d = safeParse<OcPart>(p.data);
          if (!d) continue;
          if (d.type === "text") {
            if (!d.text?.trim()) continue;
            // System-injected continuations (e.g. the nudge after a compaction)
            // are not a human turn, so they land in the same bucket as skill
            // preambles rather than inflating the prompt count.
            blocks.push({ kind: d.synthetic ? "skill_prompt" : "user_text", text: d.text });
          } else if (d.type === "compaction") {
            // OpenCode records the compaction against the user message that
            // followed it, not the assistant turn it interrupted.
            blocks.push(...this.blocksForPart(d, p.time_created, iso));
          }
        }
        if (blocks.length) {
          const msg: NeutralMessage = { role: "user", ts: iso(m.time_created), blocks };
          if (model) msg.model = model;
          if (mode) msg.permissionMode = mode;
          out.push(msg);
        }
      }
    }

    // The first message's agent is the one the session started in, so anchor
    // the band at 0 rather than prepending a duplicate segment.
    if (!modeTransitions.length) modeTransitions.push({ t: 0, mode: row.agent || "build" });
    else modeTransitions[0]!.t = 0;

    const { branch, source: branchSource } = this.resolveBranch(row.directory);

    const session: NeutralSession = {
      uuid: row.id,
      sessionId: row.id,
      cwd: row.directory,
      version: row.version,
      branch,
      branchSource,
      source: "opencode",
      title: row.title,
      firstTimestamp: iso(row.time_created),
      lastTimestamp: iso(row.time_updated),
      messages: out,
      modeTransitions,
    };
    if (Object.keys(models).length) session.models = models;
    return session;
  }

  // An assistant message is split into one neutral message per API step, so a
  // message that looped over several tool rounds reports each step's own token
  // usage instead of only the last one — which is what the context-window curve
  // is drawn from.
  private assistantMessages(
    parts: PartRow[],
    row: MessageRow,
    model: string | undefined,
    mode: string | undefined,
    iso: (ms: number) => string,
  ): NeutralMessage[] {
    const out: NeutralMessage[] = [];
    let buffer: NeutralBlock[] = [];
    let bufferTs = row.time_created;
    let started = false;

    const flush = (usage?: Usage) => {
      if (!buffer.length) {
        buffer = [];
        return;
      }
      const msg: NeutralMessage = { role: "assistant", ts: iso(bufferTs), blocks: buffer };
      if (model) msg.model = model;
      if (mode) msg.permissionMode = mode;
      if (usage) msg.usage = usage;
      out.push(msg);
      buffer = [];
    };

    for (const p of parts) {
      const d = safeParse<OcPart>(p.data);
      if (!d) continue;
      if (d.type === "step-start") {
        flush();
        bufferTs = p.time_created;
        started = true;
        continue;
      }
      if (d.type === "step-finish") {
        flush(normTokens(d.tokens));
        started = false;
        continue;
      }
      if (!buffer.length && !started) bufferTs = p.time_created;
      buffer.push(...this.blocksForPart(d, p.time_created, iso));
    }
    flush();
    return out;
  }

  private blocksForPart(
    d: OcPart,
    partMs: number,
    iso: (ms: number) => string,
  ): NeutralBlock[] {
    const ts = iso(d.time?.start ?? partMs);
    switch (d.type) {
      case "text":
        if (!d.text?.trim()) return [];
        return [{ kind: d.synthetic ? "skill_prompt" : "assistant_text", text: d.text, ts }];
      case "reasoning":
        return d.text?.trim() ? [{ kind: "thinking", text: d.text, ts }] : [];
      case "compaction":
        return [
          {
            kind: "compaction",
            ts,
            text: `The context window was compacted here (${d.auto ? "automatic" : "manual"}${d.overflow ? ", after overflow" : ""}).`,
          },
        ];
      case "tool":
        return this.blocksForTool(d, partMs, iso);
      default:
        // `patch` and `snapshot` parts point at commits in OpenCode's shadow
        // repo; the edits they cover are already captured on the `edit` tool.
        return [];
    }
  }

  private blocksForTool(
    d: OcPart,
    partMs: number,
    iso: (ms: number) => string,
  ): NeutralBlock[] {
    const ocTool = d.tool ?? "";
    const canonical = TOOL_MAP[ocTool] ?? ocTool;
    const state = d.state ?? {};
    const meta = state.metadata ?? {};

    // OpenCode times each call's start and end, so the call and its result sit
    // at their real offsets — which is what gives the simulator a true
    // wall-clock per tool rather than one shared message timestamp.
    const call: NeutralBlock = {
      kind: "tool_use",
      tool: canonical,
      displayTool: ocTool || canonical,
      ts: iso(state.time?.start ?? partMs),
      input: normalizeInput(ocTool, canonical, state.input),
    };
    if (d.callID) call.id = d.callID;

    // `edit` carries a real unified diff with exact add/delete counts — no need
    // to approximate one from the before/after strings.
    const fd = meta["filediff"] as
      | { file?: string; patch?: string; additions?: number; deletions?: number }
      | undefined;
    if (fd?.patch) {
      call.diff = {
        file: fd.file ?? "",
        patch: fd.patch,
        additions: fd.additions ?? 0,
        deletions: fd.deletions ?? 0,
      };
    }

    const output = state.output ?? "";
    if (ocTool === "task") {
      // The child session id is stated outright in the tool's metadata, and
      // echoed in the result as `<task id="…">` — no regex scrape of prose
      // needed, unlike the Claude Code path.
      const childId =
        (typeof meta["sessionId"] === "string" ? meta["sessionId"] : undefined) ??
        output.match(/<task\s+id="([^"]+)"/)?.[1];
      if (childId) call.agentId = childId;
      const m = meta["model"] as { providerID?: string; modelID?: string } | string | undefined;
      if (typeof m === "string") call.subagentModel = m;
      else if (m?.providerID && m?.modelID) call.subagentModel = `${m.providerID}/${m.modelID}`;
    }

    const blocks: NeutralBlock[] = [call];

    const status = state.status ?? "";
    const isError = status === "error";
    const isRejected = /reject|denied|deny/i.test(status);
    if (status === "completed" || isError || isRejected) {
      const text = isError ? (state.error ?? output) : output;
      blocks.push({
        kind: "tool_result",
        tool: canonical,
        displayTool: ocTool || canonical,
        ts: iso(state.time?.end ?? state.time?.start ?? partMs),
        text,
        ...(d.callID ? { toolUseId: d.callID } : {}),
        status: isRejected ? "rejected" : isError ? "error" : "ok",
        outChars: text.length,
      });
    }
    return blocks;
  }

  // Record a price/limit entry for a model the built-in catalog doesn't know, so
  // the report can price it without shipping every provider on models.dev.
  private recordModel(into: ModelCatalog, providerID: string, modelID: string): void {
    const key = `${providerID}/${modelID}`;
    if (into[key] || MODELS[key] || MODELS[modelID]) return;
    const entry = this.catalog.lookup(providerID, modelID);
    if (entry) into[key] = { ...entry, id: key };
  }

  // OpenCode's agents live in config dirs and `opencode.json(c)`, not in the
  // `agents/` + `skills/` layout Claude Code uses — and it has no skills concept
  // at all. Commands are close enough to skills to be worth listing.
  setup(): { project: SetupItem[]; user: SetupItem[] } {
    const configHome = process.env["XDG_CONFIG_HOME"]
      ? expandHome(process.env["XDG_CONFIG_HOME"])
      : path.join(os.homedir(), ".config");
    return {
      project: readOpenCodeSetup(path.join(this.opts.projectRoot, ".opencode"), this.opts.projectRoot),
      // OpenCode has no skills concept of its own, but is routinely configured
      // with `external_directory` rules pointing at `~/.claude/skills` — so
      // those skills really are part of the session's setup.
      user: [
        ...readOpenCodeSetup(path.join(configHome, "opencode")),
        ...readClaudeSkills(path.join(os.homedir(), ".claude", "skills")),
      ],
    };
  }
}

// Skills under `~/.claude/skills`, reachable from OpenCode via its
// `external_directory` allow-rules.
function readClaudeSkills(dir: string): SetupItem[] {
  if (!fs.existsSync(dir)) return [];
  const items: SetupItem[] = [];
  for (const entry of fs
    .readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const file = entry.isDirectory()
      ? path.join(dir, entry.name, "SKILL.md")
      : entry.name.endsWith(".md")
        ? path.join(dir, entry.name)
        : "";
    if (!file || !fs.existsSync(file)) continue;
    const fm = readFrontmatter(file);
    items.push({
      kind: "skill",
      name: fm.name || entry.name.replace(/\.md$/, ""),
      description: fm.description || "",
    });
  }
  return items;
}

function safeParse<T>(s: string): T | null {
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

function normTokens(t: OcTokens | undefined): Usage {
  return {
    in: t?.input ?? 0,
    // OpenCode tracks reasoning tokens separately; `Usage` has no slot for them
    // and providers that bill reasoning bill it as output, so fold them in.
    out: (t?.output ?? 0) + (t?.reasoning ?? 0),
    cw: t?.cache?.write ?? 0,
    cr: t?.cache?.read ?? 0,
  };
}

// Agents, commands and plugins configured for an OpenCode scope. `agent/*.md`
// and `command/*.md` carry frontmatter; `opencode.json(c)` can declare agents
// inline. `AGENTS.md` is the project-instructions file, the CLAUDE.md analog.
function readOpenCodeSetup(dir: string, projectRoot?: string): SetupItem[] {
  const items: SetupItem[] = [];

  const scanMd = (sub: string, kind: SetupItem["kind"]) => {
    const d = path.join(dir, sub);
    if (!fs.existsSync(d)) return;
    for (const f of fs.readdirSync(d).filter((f) => f.endsWith(".md")).sort()) {
      const fm = readFrontmatter(path.join(d, f));
      items.push({
        kind,
        name: fm.name || f.replace(/\.md$/, ""),
        description: fm.description || "",
      });
    }
  };
  scanMd("agent", "agent");
  scanMd("command", "command");

  const pluginDir = path.join(dir, "plugin");
  if (fs.existsSync(pluginDir)) {
    for (const f of fs.readdirSync(pluginDir).sort()) {
      items.push({ kind: "plugin", name: f.replace(/\.[^.]+$/, ""), description: "" });
    }
  }

  for (const name of ["opencode.json", "opencode.jsonc"]) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) continue;
    const cfg = safeParse<{ agent?: Record<string, { description?: string }> }>(stripJsonc(file));
    for (const [key, val] of Object.entries(cfg?.agent ?? {})) {
      if (items.some((i) => i.kind === "agent" && i.name === key)) continue;
      items.push({ kind: "agent", name: key, description: val?.description ?? "" });
    }
  }

  if (projectRoot) {
    const agentsMd = path.join(projectRoot, "AGENTS.md");
    if (fs.existsSync(agentsMd)) {
      items.push({
        kind: "agent",
        name: "AGENTS.md",
        description: "Project instructions loaded into every session.",
      });
    }
  }

  return items;
}

function stripJsonc(file: string): string {
  try {
    return fs
      .readFileSync(file, "utf-8")
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/\/\*[\s\S]*?\*\//g, "");
  } catch {
    return "";
  }
}

function readFrontmatter(file: string): { name?: string; description?: string } {
  try {
    const m = fs.readFileSync(file, "utf-8").match(/^---\n([\s\S]*?)\n---/);
    if (!m) return {};
    const out: { name?: string; description?: string } = {};
    for (const l of m[1]!.split("\n")) {
      const i = l.indexOf(":");
      if (i === -1) continue;
      const k = l.slice(0, i).trim();
      const v = l.slice(i + 1).trim().replace(/^["']|["']$/g, "");
      if (k === "name") out.name = v;
      if (k === "description") out.description = v;
    }
    return out;
  } catch {
    return {};
  }
}
