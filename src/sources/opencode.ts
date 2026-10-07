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
//
// The database holds one of two storage layouts, often both at once:
//
//   - v1 (opencode ≤ 1.18): `session` → `message` → `part`, one row per part.
//   - v2 (opencode 2.x): `session_v2` → `session_message`, one typed JSON row
//     per message, ordered by `seq`, each assistant row being one API step.
//
// Upgrading to 2.x copies every v1 session into the v2 tables and leaves the
// v1 rows behind; sessions created afterwards exist only in v2. So the layout is
// detected from the tables actually present — never from a version number, the
// schema has moved in both directions — and both are read and merged by id.

import { execSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { DatabaseSync } from "node:sqlite";
import { MODELS, type ModelCatalog } from "../models.ts";
import { ModelsDevCache } from "./models-dev.ts";
import { openDatabase } from "./sqlite.ts";
import type {
  ExactDiff,
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

type Layout = "v1" | "v2";

interface SessionRow {
  id: string;
  project_id: string;
  parent_id: string | null;
  directory: string;
  // Nullable in v2 until OpenCode has generated one.
  title: string | null;
  version: string;
  agent: string | null;
  model: string | null;
  time_created: number;
  time_updated: number;
  // Newest write anywhere in the session — its own row or any message in it.
  // 2.x does not bump `session_v2.time_updated` as messages arrive, so the
  // session row alone says nothing about whether a session has moved on.
  activity: number;
  // Which table set the row came from, and so which reader builds it.
  layout: Layout;
}

interface SessionMessageRow {
  id: string;
  type: string;
  time_created: number;
  data: string;
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

// v2 `session_message.data`. The row's `type` column is the discriminator; the
// JSON carries the rest. Only the fields the reader uses are typed.
interface OcModelRef {
  id?: string;
  providerID?: string;
}

interface OcV2Error {
  type?: string;
  message?: string;
}

interface OcV2Tool {
  type: "tool";
  id?: string;
  name?: string;
  state?: {
    // `streaming` | `running` | `completed` | `error`
    status?: string;
    input?: Record<string, unknown> | string;
    content?: Array<{ type?: string; text?: string; uri?: string; name?: string }>;
    error?: OcV2Error;
    metadata?: Record<string, unknown>;
  };
  time?: { created?: number; ran?: number; completed?: number };
}

type OcV2Content =
  | { type: "text"; text?: string }
  | { type: "reasoning"; text?: string; time?: { created?: number } }
  | OcV2Tool;

interface OcV2Message {
  time?: { created?: number; completed?: number };
  // user / synthetic / system / skill
  text?: string;
  name?: string;
  // assistant
  agent?: string;
  model?: OcModelRef;
  content?: OcV2Content[];
  tokens?: OcTokens;
  // agent-switched / model-switched (`model` above doubles as the new model)
  // compaction
  status?: string;
  reason?: string;
  summary?: string;
  // shell
  command?: string;
  exit?: number;
  output?: { output?: string };
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
  // 2.x renamed `bash` to `shell` and `task` to `subagent`.
  shell: "Bash",
  edit: "Edit",
  patch: "Edit",
  write: "Write",
  task: "Agent",
  subagent: "Agent",
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
    // 2.x names the target `path` on `read`, `edit` and `write`.
    case "Edit":
      return {
        file_path: i["filePath"] ?? i["file_path"] ?? i["path"] ?? "",
        old_string: i["oldString"] ?? i["old_string"] ?? "",
        new_string: i["newString"] ?? i["new_string"] ?? "",
      };
    case "Write":
      return { file_path: i["filePath"] ?? i["path"] ?? "", content: i["content"] ?? "" };
    case "Agent":
      // `task` already uses the canonical `description` / `prompt` /
      // `subagent_type` keys; 2.x's `subagent` calls the last one `agent`.
      if (i["agent"] !== undefined && i["subagent_type"] === undefined) {
        const { agent, ...rest } = i;
        return { ...rest, subagent_type: agent };
      }
      return { ...i };
    default:
      // Unmapped tools render as a JSON dump; keep the source's own shape.
      return { ...i, ...(ocTool ? {} : {}) };
  }
}

// --- Adapter ---

export interface OpenCodeAdapterOptions {
  projectRoot: string;
  // Other roots the same project's sessions may be keyed under (git worktrees,
  // Conductor workspaces). One adapter — one database open — covers them all.
  extraRoots?: string[];
  // Overrides the XDG data dir (mirrors `--claude-dir`).
  dataDir?: string;
  cacheDir?: string;
}

// Columns each layout's reader depends on. The database schema is internal to
// OpenCode and unversioned, so a layout counts as present only when every one of
// these exists — and when neither does, fail loudly rather than silently
// exporting nothing after an upstream change.
const SESSION_COLUMNS = [
  "id",
  "project_id",
  "parent_id",
  "directory",
  "title",
  "version",
  "time_created",
  "time_updated",
];
const LAYOUT_COLUMNS: Record<Layout, Record<string, string[]>> = {
  v1: {
    session: SESSION_COLUMNS,
    message: ["id", "session_id", "time_created", "time_updated", "data"],
    part: ["id", "message_id", "session_id", "time_created", "time_updated", "data"],
  },
  v2: {
    session_v2: SESSION_COLUMNS,
    session_message: ["id", "session_id", "type", "seq", "time_created", "time_updated", "data"],
  },
};
const SESSION_TABLE: Record<Layout, string> = { v1: "session", v2: "session_v2" };
// Tables whose rows belong to a session, for its `activity`.
const CONTENT_TABLES: Record<Layout, string[]> = {
  v1: ["message", "part"],
  v2: ["session_message"],
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
  private readonly roots: string[];
  // Layouts present in this database, and the optional session columns each
  // one has (`agent` / `model` arrived partway through 1.x).
  private readonly layouts: Layout[];
  private readonly optionalColumns = new Map<Layout, Set<string>>();
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
    this.layouts = this.detectLayouts();

    const cacheDir = opts.cacheDir
      ? expandHome(opts.cacheDir)
      : path.join(
          process.env["XDG_CACHE_HOME"]
            ? expandHome(process.env["XDG_CACHE_HOME"])
            : path.join(os.homedir(), ".cache"),
          "opencode",
        );
    this.catalog = new ModelsDevCache(path.join(cacheDir, "models.json"));
    this.roots = [opts.projectRoot, ...(opts.extraRoots ?? [])];
    this.projectIds = this.findProjectIds(this.roots);
  }

  private columnsOf(table: string): string[] {
    return (this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
      (r) => r.name,
    );
  }

  private detectLayouts(): Layout[] {
    const found: Layout[] = [];
    const problems: string[] = [];
    for (const layout of ["v1", "v2"] as const) {
      const missing: string[] = [];
      for (const [table, columns] of Object.entries(LAYOUT_COLUMNS[layout])) {
        const cols = this.columnsOf(table);
        if (!cols.length) missing.push(`table '${table}'`);
        else missing.push(...columns.filter((c) => !cols.includes(c)).map((c) => `${table}.${c}`));
      }
      if (missing.length) {
        problems.push(`${layout}: missing ${missing.join(", ")}`);
        continue;
      }
      found.push(layout);
      const sessionCols = this.columnsOf(SESSION_TABLE[layout]);
      this.optionalColumns.set(
        layout,
        new Set(["agent", "model"].filter((c) => sessionCols.includes(c))),
      );
    }
    if (!found.length) {
      throw new Error(
        `OpenCode database schema has diverged: no known session layout ` +
          `(${problems.join("; ")}). This exporter reads opencode 1.x and 2.x.`,
      );
    }
    return found;
  }

  // A project is keyed by its worktree; worktrees and sandboxes of the same
  // project are additionally listed in `project_directory` (absent before 1.18).
  private findProjectIds(roots: string[]): string[] {
    const ids = new Set<string>();
    const hasProjectDirectory = this.columnsOf("project_directory").length > 0;
    for (const root of roots) {
      for (const r of this.db
        .prepare("SELECT id FROM project WHERE worktree = ?")
        .all(root) as Array<{ id: string }>) {
        ids.add(r.id);
      }
      if (!hasProjectDirectory) continue;
      for (const r of this.db
        .prepare("SELECT project_id FROM project_directory WHERE directory = ?")
        .all(root) as Array<{ project_id: string }>) {
        ids.add(r.project_id);
      }
    }
    return [...ids];
  }

  // Sessions are matched by project *or* by working directory. OpenCode's own
  // project attribution is not reliable across its migrations — sessions have
  // been left under the catch-all `global` project, or split off into a new one
  // — and an exporter should rather over-include a session that ran in one of
  // our roots than drop it.
  //
  // A session copied from v1 into v2 is returned once: the v1 copy unless the v2
  // one saw activity later (the session was continued after the upgrade). The
  // migration keeps the original message timestamps, so an untouched session
  // ties — and ties go to v1, whose copy is the lossless one (spec §10.3).
  private sessionsWhere(clause: string, params: string[]): SessionRow[] {
    const byId = new Map<string, SessionRow>();
    for (const layout of this.layouts) {
      for (const row of this.sessionRows(layout, clause, params)) {
        const prev = byId.get(row.id);
        if (!prev || row.activity > prev.activity) byId.set(row.id, row);
      }
    }
    return [...byId.values()];
  }

  private sessionRows(layout: Layout, clause: string, params: string[]): SessionRow[] {
    const opt = this.optionalColumns.get(layout)!;
    const ids = this.projectIds.map(() => "?").join(",");
    const dirs = this.roots.map(() => "?").join(",");
    const scope = this.projectIds.length
      ? `(project_id IN (${ids}) OR directory IN (${dirs}))`
      : `directory IN (${dirs})`;
    const rows = this.db
      .prepare(
        `SELECT id, project_id, parent_id, directory, title, version,
                ${opt.has("agent") ? "agent" : "NULL AS agent"},
                ${opt.has("model") ? "model" : "NULL AS model"},
                time_created, time_updated,
                MAX(s.time_updated, ${CONTENT_TABLES[layout]
                  .map((t) => `COALESCE((SELECT MAX(c.time_updated) FROM ${t} c WHERE c.session_id = s.id), 0)`)
                  .join(", ")}) AS activity
         FROM ${SESSION_TABLE[layout]} s WHERE ${scope} AND ${clause}`,
      )
      .all(...this.projectIds, ...this.roots, ...params) as unknown as SessionRow[];
    for (const r of rows) {
      r.layout = layout;
      // v1 maintains its own `time_updated`, and its exports have always been
      // stamped with it; 2.x's is stale from the first message on.
      if (layout === "v2") r.time_updated = r.activity;
    }
    return rows;
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
        mtime: Math.max(s.activity, ...this.descendantsOf(s.id).map((d) => d.activity), 0),
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
    return row.layout === "v2" ? this.buildSessionV2(row) : this.buildSessionV1(row);
  }

  private buildSessionV1(row: SessionRow): NeutralSession {
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
    return this.finishSession(row, out, models, modeTransitions);
  }

  private finishSession(
    row: SessionRow,
    messages: NeutralMessage[],
    models: ModelCatalog,
    modeTransitions: Array<{ t: number; mode: string }>,
  ): NeutralSession {
    const iso = (ms: number) => new Date(ms).toISOString();
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
      // v2 leaves the title null until one is generated; the exporter then
      // falls back to the first prompt.
      ...(row.title !== null ? { title: row.title } : {}),
      firstTimestamp: iso(row.time_created),
      lastTimestamp: iso(row.time_updated),
      messages,
      modeTransitions,
    };
    if (Object.keys(models).length) session.models = models;
    return session;
  }

  // v2: one typed row per message, already in order. Each assistant row is a
  // single API step with its own usage, so it maps onto one neutral message
  // directly — no step-start/step-finish splitting as in v1.
  private buildSessionV2(row: SessionRow): NeutralSession {
    const rows = this.db
      .prepare(
        "SELECT id, type, time_created, data FROM session_message WHERE session_id = ? ORDER BY seq",
      )
      .all(row.id) as unknown as SessionMessageRow[];

    const out: NeutralMessage[] = [];
    const models: ModelCatalog = {};
    const modeTransitions: Array<{ t: number; mode: string }> = [];
    const startMs = row.time_created;
    const iso = (ms: number) => new Date(ms).toISOString();

    // User-side rows carry no agent or model of their own; they inherit what
    // the session is currently set to, as v1 user messages recorded it.
    let mode: string | undefined = row.agent ?? undefined;
    let model: string | undefined = modelKey(safeParse<OcModelRef>(row.model ?? ""));
    const setMode = (next: string | undefined, ms: number) => {
      if (!next) return;
      mode = next;
      const prev = modeTransitions[modeTransitions.length - 1];
      if (!prev || prev.mode !== next) modeTransitions.push({ t: (ms - startMs) / 1000, mode: next });
    };
    const setModel = (ref: OcModelRef | undefined) => {
      const key = modelKey(ref);
      if (!key) return;
      model = key;
      if (ref?.providerID && ref.id) this.recordModel(models, ref.providerID, ref.id);
    };
    const push = (role: NeutralMessage["role"], ts: number, blocks: NeutralBlock[], usage?: Usage) => {
      if (!blocks.length) return;
      const msg: NeutralMessage = { role, ts: iso(ts), blocks };
      if (model) msg.model = model;
      if (mode) msg.permissionMode = mode;
      if (usage) msg.usage = usage;
      out.push(msg);
    };

    for (const r of rows) {
      const d = safeParse<OcV2Message>(r.data);
      if (!d) continue;
      const ms = d.time?.created ?? r.time_created;
      switch (r.type) {
        case "user":
          push("user", ms, d.text?.trim() ? [{ kind: "user_text", text: d.text }] : []);
          break;
        // Injected context — continuation nudges, tool-set change notices, a
        // loaded skill's body — not a human turn, so it lands in the same
        // bucket as v1's synthetic parts rather than inflating the prompt count.
        case "synthetic":
        case "system":
        case "skill":
          push("user", ms, d.text?.trim() ? [{ kind: "skill_prompt", text: d.text, ts: iso(ms) }] : []);
          break;
        // A `!command` the user ran in the session's shell.
        case "shell": {
          const output = d.output?.output ?? "";
          const text =
            `\`$ ${d.command ?? ""}\`` +
            (d.exit !== undefined ? ` (exit ${d.exit})` : "") +
            (output.trim() ? `\n\n\`\`\`\n${output.trimEnd()}\n\`\`\`` : "");
          push("user", ms, [{ kind: "local_command", text, ts: iso(ms) }]);
          break;
        }
        case "agent-switched":
          setMode(d.agent, ms);
          break;
        case "model-switched":
          setModel(d.model);
          break;
        case "assistant": {
          setMode(d.agent, ms);
          setModel(d.model);
          const blocks: NeutralBlock[] = [];
          for (const c of d.content ?? []) {
            if (c.type === "text") {
              if (c.text?.trim()) blocks.push({ kind: "assistant_text", text: c.text, ts: iso(ms) });
            } else if (c.type === "reasoning") {
              if (c.text?.trim()) {
                blocks.push({ kind: "thinking", text: c.text, ts: iso(c.time?.created ?? ms) });
              }
            } else if (c.type === "tool") {
              blocks.push(...this.blocksForV2Tool(c, ms, iso));
            }
          }
          push("assistant", ms, blocks, d.tokens ? normTokens(d.tokens) : undefined);
          break;
        }
        case "compaction": {
          // As in v1: the compaction marker on the user side, then the summary
          // call as an assistant turn carrying that request's own usage.
          if (d.status === "running") break;
          const failed = d.status === "failed";
          push("user", ms, [
            {
              kind: "compaction",
              ts: iso(ms),
              text: `The context window was compacted here (${d.reason === "auto" ? "automatic" : "manual"}${failed ? ", failed" : ""}).`,
            },
          ]);
          if (!failed && d.summary?.trim()) {
            setModel(d.model);
            push(
              "assistant",
              ms,
              [{ kind: "assistant_text", text: d.summary, ts: iso(ms) }],
              d.tokens ? normTokens(d.tokens) : undefined,
            );
          }
          break;
        }
        // `idle` closes a turn and `location-switched` moves the working
        // directory; neither is content.
        default:
          break;
      }
    }

    return this.finishSession(row, out, models, modeTransitions);
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
    const state = d.state ?? {};
    const meta = state.metadata ?? {};
    const output = state.output ?? "";

    let agentId: string | undefined;
    let subagentModel: string | undefined;
    if (ocTool === "task") {
      // The child session id is stated outright in the tool's metadata, and
      // echoed in the result as `<task id="…">` — no regex scrape of prose
      // needed, unlike the Claude Code path.
      agentId =
        (typeof meta["sessionId"] === "string" ? meta["sessionId"] : undefined) ??
        output.match(/<task\s+id="([^"]+)"/)?.[1];
      const m = meta["model"] as { providerID?: string; modelID?: string } | string | undefined;
      if (typeof m === "string") subagentModel = m;
      else if (m?.providerID && m?.modelID) subagentModel = `${m.providerID}/${m.modelID}`;
    }

    const status = state.status ?? "";
    const isError = status === "error";
    const isRejected = /reject|denied|deny/i.test(status);
    return this.toolBlocks(
      {
        ocTool,
        callId: d.callID,
        input: state.input,
        startMs: state.time?.start ?? partMs,
        endMs: state.time?.end ?? state.time?.start ?? partMs,
        diff: singleFileDiff(meta["filediff"]),
        agentId,
        subagentModel,
        result:
          status === "completed" || isError || isRejected
            ? {
                text: isError ? (state.error ?? output) : output,
                status: isRejected ? "rejected" : isError ? "error" : "ok",
              }
            : undefined,
      },
      iso,
    );
  }

  // v2 tool calls carry the same information as v1's tool parts under new
  // names: output as a content array, the error as a structured object, the
  // diff as a list of files, and `subagent` reporting its child as `sessionID`.
  private blocksForV2Tool(c: OcV2Tool, msgMs: number, iso: (ms: number) => string): NeutralBlock[] {
    const ocTool = c.name ?? "";
    const state = c.state ?? {};
    const meta = state.metadata ?? {};
    // While streaming, the input is still a partial JSON string.
    const input = typeof state.input === "object" ? state.input : undefined;
    const output = (state.content ?? [])
      .map((p) => (p.type === "text" ? (p.text ?? "") : `[${p.name ?? p.uri ?? "file"}]`))
      .join("\n");

    let agentId: string | undefined;
    let subagentModel: string | undefined;
    if (TOOL_MAP[ocTool] === "Agent") {
      const id = meta["sessionID"] ?? meta["sessionId"];
      agentId =
        (typeof id === "string" ? id : undefined) ??
        output.match(/<subagent\s+sessionID="([^"]+)"/)?.[1] ??
        output.match(/<task\s+id="([^"]+)"/)?.[1];
      if (typeof input?.["model"] === "string" && input["model"]) subagentModel = input["model"];
    }

    const status = state.status ?? "";
    const errorText = state.error ? (state.error.message ?? "") : "";
    // A refused permission is an error like any other in 2.x; tell it apart by
    // its type or OpenCode's own wording (migrated v1 rejections, a declined
    // prompt, a config `deny` rule) — not by a bare "denied", which a tool's
    // own EACCES message would also match.
    const isRejected =
      status === "error" &&
      (/permission/i.test(state.error?.type ?? "") ||
        /rejected permission|declined|^(Error: )?Permission denied: /.test(errorText));
    const startMs = c.time?.created ?? msgMs;
    return this.toolBlocks(
      {
        ocTool,
        callId: c.id,
        input,
        startMs,
        endMs: c.time?.completed ?? c.time?.ran ?? startMs,
        // Migrated v1 calls keep `filediff`; native 2.x ones list `files`.
        diff: singleFileDiff(meta["filediff"]) ?? mergedFileDiff(meta["files"]),
        agentId,
        subagentModel,
        result:
          status === "completed"
            ? { text: output, status: "ok" }
            : status === "error"
              ? { text: errorText || output, status: isRejected ? "rejected" : "error" }
              : undefined,
      },
      iso,
    );
  }

  private toolBlocks(t: ToolCall, iso: (ms: number) => string): NeutralBlock[] {
    const canonical = TOOL_MAP[t.ocTool] ?? t.ocTool;

    // OpenCode times each call's start and end, so the call and its result sit
    // at their real offsets — which is what gives the simulator a true
    // wall-clock per tool rather than one shared message timestamp.
    const call: NeutralBlock = {
      kind: "tool_use",
      tool: canonical,
      displayTool: t.ocTool || canonical,
      ts: iso(t.startMs),
      input: normalizeInput(t.ocTool, canonical, t.input),
    };
    if (t.callId) call.id = t.callId;
    // Edits carry a real unified diff with exact add/delete counts — no need
    // to approximate one from the before/after strings.
    if (t.diff) call.diff = t.diff;
    if (t.agentId) call.agentId = t.agentId;
    if (t.subagentModel) call.subagentModel = t.subagentModel;

    const blocks: NeutralBlock[] = [call];
    if (t.result) {
      blocks.push({
        kind: "tool_result",
        tool: canonical,
        displayTool: t.ocTool || canonical,
        ts: iso(t.endMs),
        text: t.result.text,
        ...(t.callId ? { toolUseId: t.callId } : {}),
        status: t.result.status,
        outChars: t.result.text.length,
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

// A tool call as both layouts describe it, once their field names are resolved.
interface ToolCall {
  ocTool: string;
  callId: string | undefined;
  input: Record<string, unknown> | undefined;
  startMs: number;
  endMs: number;
  diff: ExactDiff | undefined;
  agentId: string | undefined;
  subagentModel: string | undefined;
  // Absent while the call is still pending or running.
  result: { text: string; status: "ok" | "error" | "rejected" } | undefined;
}

interface OcFileDiff {
  file?: string;
  patch?: string;
  additions?: number;
  deletions?: number;
}

function singleFileDiff(v: unknown): ExactDiff | undefined {
  const fd = v as OcFileDiff | undefined;
  if (!fd?.patch) return undefined;
  return {
    file: fd.file ?? "",
    patch: fd.patch,
    additions: fd.additions ?? 0,
    deletions: fd.deletions ?? 0,
  };
}

// 2.x `edit`/`write` report a one-entry `files` list; `patch` can touch several
// files in one call, which the neutral diff — one per call — folds into one.
function mergedFileDiff(v: unknown): ExactDiff | undefined {
  if (!Array.isArray(v)) return undefined;
  const files = (v as OcFileDiff[]).filter((f) => f?.patch);
  if (!files.length) return undefined;
  if (files.length === 1) return singleFileDiff(files[0]);
  return {
    file: files[0]!.file ?? "",
    patch: files.map((f) => f.patch).join("\n"),
    additions: files.reduce((n, f) => n + (f.additions ?? 0), 0),
    deletions: files.reduce((n, f) => n + (f.deletions ?? 0), 0),
  };
}

function modelKey(ref: OcModelRef | null | undefined): string | undefined {
  if (!ref?.id) return undefined;
  return ref.providerID ? `${ref.providerID}/${ref.id}` : ref.id;
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
