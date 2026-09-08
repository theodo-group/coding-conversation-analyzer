// sources/cursor — read Cursor sessions into the neutral intermediate.
//
// Cursor keeps every conversation in one SQLite database,
// `Cursor/User/globalStorage/state.vscdb`, opened read-only through the shared
// helper so an export is safe while Cursor is running (its write-ahead log runs
// to half the size of the main file, and must be replayed — see `sqlite.ts`).
// The `~/.cursor/projects/**/agent-transcripts/*.jsonl` mirror is deliberately
// *not* used: it carries no timestamps, no tool results and no ids, so it is a
// prompt-replay log rather than a transcript. See `docs/cursor-export-spec.md`.
//
// Three things here differ from the other adapters and account for most of the
// code:
//
//   1. Cursor fuses a tool call and its result into one `bubbleId` record, so
//      each is split back into the `tool_use` + `tool_result` pair the exporter
//      expects (§3.2 of the spec) — the inverse of the Claude adapter's join.
//   2. `toolFormerData.params` / `.result` / `.error` are JSON-encoded *strings*,
//      not objects, and its tool names are versioned snake_case — both are
//      normalised here onto the canonical names and keys.
//   3. Cursor records no token usage whatsoever: every `tokenCount` on disk is
//      `{inputTokens: 0, outputTokens: 0}` because usage is metered
//      server-side. The session is flagged `usageAvailable: false` rather than
//      carrying zeros, so the reports state that cost is unavailable instead of
//      claiming the session was free.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "./sqlite.ts";
import type {
  ContextBreakdown,
  NeutralBlock,
  NeutralConversation,
  NeutralMessage,
  NeutralSession,
  NeutralTranscript,
  SetupItem,
  SourceAdapter,
  SourceSessionRef,
} from "./types.ts";

// --- Record shapes ---

// One row of `composerHeaders`, the cheap enumeration index. Cursor 3.19 names
// these columns; older builds had the same ten columns unnamed.
interface HeaderRow {
  composerId: string;
  workspaceId: string | null;
  createdAt: number | null;
  lastUpdatedAt: number | null;
  isArchived: number | null;
  isSubagent: number | null;
  recency: number | null;
  subagentTypeName: string | null;
}

// An entry of `composerData.fullConversationHeadersOnly` — the ordered index of
// the conversation. This array, not a `createdAt` sort, is the message order.
interface BubbleHeader {
  bubbleId?: string;
  type?: number; // 1 = user, 2 = assistant
  createdAt?: string; // ISO
  startedAtMs?: number;
  completedAtMs?: number;
  grouping?: { thinkingDurationMs?: number; turnDurationMs?: number };
}

interface ToolFormerData {
  tool?: number; // stable numeric enum
  name?: string; // versioned snake_case name
  status?: string; // completed | error | cancelled | loading
  toolCallId?: string;
  params?: string; // JSON-encoded
  rawArgs?: string; // the model's literal argument string
  result?: string; // JSON-encoded
  error?: string; // JSON-encoded {clientVisibleErrorMessage, modelVisibleErrorMessage}
  additionalData?: Record<string, unknown>;
}

interface Bubble {
  bubbleId?: string;
  type?: number;
  text?: string;
  thinking?: { text?: string };
  thinkingDurationMs?: number;
  toolFormerData?: ToolFormerData;
  createdAt?: string;
  startedAtMs?: number;
  completedAtMs?: number;
}

interface ComposerData {
  composerId?: string;
  name?: string;
  status?: string;
  isDraft?: boolean;
  unifiedMode?: string;
  createdAt?: number;
  lastUpdatedAt?: number;
  contextTokensUsed?: number;
  contextTokenLimit?: number;
  modelConfig?: { modelName?: string };
  workspaceIdentifier?: { id?: string; uri?: { fsPath?: string } };
  trackedGitRepos?: Array<{ repoPath?: string; branches?: Array<{ branchName?: string }> }>;
  subagentComposerIds?: string[];
  fullConversationHeadersOnly?: BubbleHeader[];
  promptTokenBreakdown?: {
    totalUsedTokens?: number;
    maxTokens?: number;
    categories?: Array<{ id?: string; label?: string; estimatedTokens?: number }>;
  };
}

// --- Tool mapping (§3.3) ---

// Cursor's versioned snake_case tool names → the canonical names the exporter
// formats and buckets against. `toolFormerData.tool` is a stable numeric enum
// and `name` the string; the string is matched first and the enum is the
// fallback, so a rename upstream degrades to the right bucket instead of
// dropping to `other`.
const TOOL_MAP: Record<string, string> = {
  read_file_v2: "Read",
  read_file: "Read",
  list_dir: "Read",
  read_lints: "Read",
  glob_file_search: "Glob",
  file_search: "Glob",
  ripgrep_raw_search: "Grep",
  grep_search: "Grep",
  codebase_search: "Grep",
  edit_file_v2: "Edit",
  edit_file: "Edit",
  search_replace: "Edit",
  str_replace: "Edit",
  write_file: "Write",
  create_file: "Write",
  run_terminal_command_v2: "Bash",
  run_terminal_cmd: "Bash",
  task_v2: "Agent",
  task: "Agent",
  todo_write: "TodoWrite",
  update_current_step: "TodoWrite",
  web_search: "WebSearch",
  fetch_rules: "Read",
};

// Numeric fallback for the tools this exporter has actually seen, used when the
// name is missing or has been versioned past the table above.
const TOOL_BY_ENUM: Record<number, string> = {
  15: "Bash",
  38: "Edit",
  40: "Read",
  41: "Grep",
  42: "Glob",
  48: "Agent",
};

// Cursor's camelCase tool params → the canonical snake_case keys, so the shared
// `formatToolInput` renders real diffs and code blocks rather than a JSON dump.
function normalizeInput(
  canonical: string,
  params: Record<string, unknown>,
  rawArgs: Record<string, unknown>,
): Record<string, unknown> {
  // `params` is what Cursor resolved (absolute paths, defaults filled in);
  // `rawArgs` is what the model literally wrote, and is empty on
  // client-initiated calls. Prefer the resolved value, fall back to the raw one.
  const pick = (...keys: string[]): unknown => {
    for (const k of keys) {
      if (params[k] !== undefined && params[k] !== "") return params[k];
      if (rawArgs[k] !== undefined && rawArgs[k] !== "") return rawArgs[k];
    }
    return undefined;
  };
  const str = (...keys: string[]): string => {
    const v = pick(...keys);
    return typeof v === "string" ? v : v === undefined ? "" : String(v);
  };

  switch (canonical) {
    case "Read": {
      const out: Record<string, unknown> = {
        file_path: str("targetFile", "effectiveUri", "path", "relativeWorkspacePath"),
      };
      const offset = pick("offset", "startLine");
      const limit = pick("limit", "numLines");
      if (typeof offset === "number") out["offset"] = offset;
      if (typeof limit === "number") out["limit"] = limit;
      return out;
    }
    case "Glob": {
      const out: Record<string, unknown> = { pattern: str("globPattern", "pattern", "query") };
      const dir = str("targetDirectory", "path");
      if (dir) out["path"] = dir;
      return out;
    }
    case "Grep": {
      const out: Record<string, unknown> = { pattern: str("pattern", "query") };
      const p = str("path", "targetDirectory");
      if (p) out["path"] = p;
      const glob = str("glob");
      if (glob) out["glob"] = glob;
      return out;
    }
    case "Bash": {
      const out: Record<string, unknown> = { command: str("command") };
      const desc = str("commandDescription", "explanation");
      if (desc) out["description"] = desc;
      const cwd = str("cwd");
      if (cwd) out["cwd"] = cwd;
      return out;
    }
    case "Edit":
      return {
        file_path: str("relativeWorkspacePath", "targetFile", "path"),
        old_string: str("oldString", "old_string"),
        new_string: str("newString", "new_string", "codeEdit", "code_edit"),
      };
    case "Write":
      return {
        file_path: str("path", "relativeWorkspacePath", "targetFile"),
        content: str("contents", "content", "codeEdit"),
      };
    case "Agent": {
      const out: Record<string, unknown> = {
        description: str("description"),
        prompt: str("prompt"),
      };
      // Cursor records both a `subagentType` — routinely the literal
      // `"unspecified"` — and a `name` holding the agent that actually ran
      // ("general-purpose"). Prefer the one that says something.
      const named = str("name");
      const type = str("subagentType", "subagent_type", "agentType");
      const chosen = named || (type === "unspecified" ? "" : type);
      if (chosen) out["subagent_type"] = chosen;
      return out;
    }
    default:
      // Unmapped tools (MCP servers, anything new) render as a JSON dump; keep
      // Cursor's own shape rather than inventing keys for it.
      return { ...params };
  }
}

// --- Small helpers ---

function expandHome(p: string): string {
  return path.resolve(p.replace(/^~(?=$|\/)/, os.homedir()));
}

// `params` / `result` / `error` are JSON *strings*, and any of them can be
// absent, empty, or (after an upstream change) not JSON at all.
function parseObject(s: string | undefined): Record<string, unknown> {
  if (!s) return {};
  try {
    const v: unknown = JSON.parse(s);
    return v !== null && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function isoOf(ms: number | undefined, fallback: string): string {
  return typeof ms === "number" && ms > 0 ? new Date(ms).toISOString() : fallback;
}

// A bubble's start, in epoch ms — the key the header array and the stored rows
// always agree on, and so the fallback when their ids don't line up.
function bubbleTime(b: { startedAtMs?: number; createdAt?: string }): number | undefined {
  if (typeof b.startedAtMs === "number") return b.startedAtMs;
  const t = b.createdAt ? Date.parse(b.createdAt) : NaN;
  return Number.isNaN(t) ? undefined : t;
}

const headerTime = bubbleTime;

// `LIKE` treats `%` and `_` as wildcards, and a composerId is only ever a UUID
// — but a prefix match built from unescaped input is a bug waiting for the day
// that stops being true.
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => "\\" + c);
}

// The default macOS/Linux/Windows application-support roots, in that order.
function defaultCursorRoots(): string[] {
  const home = os.homedir();
  const appData = process.env["APPDATA"];
  return [
    path.join(home, "Library", "Application Support", "Cursor"),
    path.join(home, ".config", "Cursor"),
    ...(appData ? [path.join(appData, "Cursor")] : []),
  ];
}

// --- Adapter ---

export interface CursorAdapterOptions {
  projectRoot: string;
  // Other roots the same project's sessions may be keyed under (git worktrees,
  // Conductor workspaces). One adapter — one database open — covers them all.
  extraRoots?: string[];
  // Overrides the Cursor application-support root (mirrors `--claude-dir`).
  // Point it at a frozen copy to make an export reproducible.
  cursorDir?: string;
}

export class CursorAdapter implements SourceAdapter {
  readonly source = "cursor" as const;
  readonly origin: string;

  private readonly db: DatabaseSync;
  private readonly opts: CursorAdapterOptions;
  private readonly root: string;
  private readonly workspaceIds: Set<string>;
  // toolCallId → the full result text, from the `agentKv` blobs. Built once on
  // first use; the blobs are content-addressed across every composer, so one
  // scan serves the whole export.
  private resultsByCallId: Map<string, string> | null = null;
  // composerId → its parsed bubble rows, so a conversation and its subagents
  // are each read from the database once.
  private readonly rowCache = new Map<string, Bubble[]>();
  // composerId → its decoded `composerData`. Each is ~50 KB of JSON and is
  // wanted several times over (enumeration, subagent filtering, loading).
  private readonly dataCache = new Map<string, ComposerData | null>();

  constructor(opts: CursorAdapterOptions) {
    this.opts = opts;
    const roots = opts.cursorDir ? [expandHome(opts.cursorDir)] : defaultCursorRoots();
    const found = roots.find((r) =>
      fs.existsSync(path.join(r, "User", "globalStorage", "state.vscdb")),
    );
    if (!found) {
      throw new Error(`Cursor database not found: ${roots.map((r) => path.join(r, "User/globalStorage/state.vscdb")).join(", ")}`);
    }
    this.root = found;
    const dbPath = path.join(found, "User", "globalStorage", "state.vscdb");
    this.origin = dbPath;
    this.db = openDatabase(dbPath);
    this.assertSchema();
    this.workspaceIds = this.findWorkspaceIds([opts.projectRoot, ...(opts.extraRoots ?? [])]);
  }

  // Cursor's schema is internal and unversioned, so check the two tables this
  // reader depends on up front and fail loudly rather than silently exporting
  // an empty conversation after an upstream change.
  private assertSchema(): void {
    const required: Record<string, string[]> = {
      cursorDiskKV: ["key", "value"],
      composerHeaders: ["composerId", "workspaceId", "createdAt", "lastUpdatedAt"],
    };
    for (const [table, columns] of Object.entries(required)) {
      let cols: string[];
      try {
        cols = (this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
          (r) => r.name,
        );
      } catch (e) {
        throw new Error(`Cursor database: cannot read table ${table} (${e})`);
      }
      const missing = columns.filter((c) => !cols.includes(c));
      if (!cols.length || missing.length) {
        throw new Error(
          `Cursor database schema has diverged: ${table} is missing ` +
            `${cols.length ? missing.join(", ") : "entirely"}. ` +
            `This exporter was written against Cursor 3.19 (state.vscdb _v: 18).`,
        );
      }
    }
  }

  // Workspace ids for this project root. `workspaceStorage/<id>/workspace.json`
  // states the folder outright, so this is exact and needs no path-slug
  // guessing — and it is far cheaper than decoding one 50 KB `composerData` per
  // session just to read `workspaceIdentifier.uri.fsPath`.
  private findWorkspaceIds(projectRoots: string[]): Set<string> {
    const ids = new Set<string>();
    const dir = path.join(this.root, "User", "workspaceStorage");
    if (!fs.existsSync(dir)) return ids;
    const wanted = new Set(projectRoots.map((r) => path.resolve(r)));
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = path.join(dir, entry.name, "workspace.json");
      if (!fs.existsSync(file)) continue;
      try {
        const cfg = JSON.parse(fs.readFileSync(file, "utf-8")) as { folder?: string };
        if (!cfg.folder) continue;
        const folder = path.resolve(decodeURIComponent(cfg.folder.replace(/^file:\/\//, "")));
        if (wanted.has(folder)) ids.add(entry.name);
      } catch {
        /* an unreadable workspace.json just isn't this project's */
      }
    }
    return ids;
  }

  private kv(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM cursorDiskKV WHERE key = ?").get(key) as
      | { value: unknown }
      | undefined;
    if (row?.value === undefined || row.value === null) return null;
    return typeof row.value === "string" ? row.value : Buffer.from(row.value as Uint8Array).toString("utf-8");
  }

  private composerData(id: string): ComposerData | null {
    const cached = this.dataCache.get(id);
    if (cached !== undefined) return cached;
    const raw = this.kv(`composerData:${id}`);
    let data: ComposerData | null = null;
    if (raw) {
      try {
        data = JSON.parse(raw) as ComposerData;
      } catch {
        data = null;
      }
    }
    this.dataCache.set(id, data);
    return data;
  }

  private headerRows(): HeaderRow[] {
    if (!this.workspaceIds.size) return [];
    const holes = [...this.workspaceIds].map(() => "?").join(",");
    return this.db
      .prepare(
        `SELECT composerId, workspaceId, createdAt, lastUpdatedAt, isArchived, isSubagent,
                recency, subagentTypeName
         FROM composerHeaders WHERE workspaceId IN (${holes})`,
      )
      .all(...this.workspaceIds) as unknown as HeaderRow[];
  }

  list(): SourceSessionRef[] {
    const rows = this.headerRows();

    // A composer listed in another composer's `subagentComposerIds` is a
    // subagent transcript, not a top-level session — it is exported nested under
    // its parent. `isSubagent` says the same thing in one column, but only on
    // builds that have it, so both are consulted.
    const children = new Set<string>();
    for (const r of rows) {
      if (r.isSubagent) children.add(r.composerId);
      for (const id of this.composerData(r.composerId)?.subagentComposerIds ?? []) children.add(id);
    }

    return rows
      .filter((r) => r.composerId !== "empty-state-draft" && !children.has(r.composerId))
      .map((r) => ({ row: r, data: this.composerData(r.composerId) }))
      .filter(({ data }) => !!data && !data.isDraft && !!data.fullConversationHeadersOnly?.length)
      .sort((a, b) => (a.row.createdAt ?? 0) - (b.row.createdAt ?? 0))
      .map(({ row, data }) => ({
        uuid: row.composerId,
        // `composerId` is a UUID, so the first 8 hex characters match the
        // existing `<timestamp>-<prefix>` convention; the `cu` tag keeps it
        // unambiguous next to Claude Code's stems in a mixed-source directory.
        prefix: "cu" + row.composerId.replace(/-/g, "").slice(0, 8),
        // A session's tree is only as fresh as its newest subagent: a running
        // child updates while the parent's own timestamp stays put. Cursor
        // leaves `lastUpdatedAt` null on some composers, so fall back through
        // `recency` and `createdAt` rather than treating null as epoch — an
        // export dated 1970 would look permanently up to date.
        mtime: Math.max(
          ...[row, ...(data?.subagentComposerIds ?? []).map((id) => this.headerFor(id))]
            .filter((r): r is HeaderRow => !!r)
            .map((r) => r.lastUpdatedAt ?? r.recency ?? r.createdAt ?? 0),
          0,
        ),
      }));
  }

  private headerFor(id: string): HeaderRow | undefined {
    return this.db
      .prepare(
        `SELECT composerId, workspaceId, createdAt, lastUpdatedAt, isArchived, isSubagent,
                recency, subagentTypeName
         FROM composerHeaders WHERE composerId = ?`,
      )
      .get(id) as unknown as HeaderRow | undefined;
  }

  load(ref: SourceSessionRef): NeutralConversation {
    const data = this.composerData(ref.uuid);
    if (!data) throw new Error(`Cursor conversation not found: ${ref.uuid}`);

    const session = this.buildSession(ref.uuid, data);

    // Cursor has no workflow concept — the tier is simply never created.
    return { session, subagents: this.descendantsOf(ref.uuid, data), workflows: [] };
  }

  // Every subagent transcript beneath a conversation, breadth-first. Subagents
  // are stated outright (`subagentComposerIds`) rather than inferred from
  // sidechain heuristics, and a subagent can spawn its own — so this recurses
  // rather than assuming a single generation.
  //
  // A retried spawn names the attempts it replaced, and those are still listed
  // as children; without excluding them each abandoned attempt would export as
  // a duplicate transcript of the one that superseded it.
  private descendantsOf(rootId: string, rootData: ComposerData): NeutralTranscript[] {
    const out: NeutralTranscript[] = [];
    const seen = new Set<string>([rootId]);
    const queue: Array<{ id: string; data: ComposerData }> = [{ id: rootId, data: rootData }];
    while (queue.length) {
      const { id: parentId, data } = queue.shift()!;
      const superseded = this.supersededIds(parentId);
      for (const id of data.subagentComposerIds ?? []) {
        if (seen.has(id) || superseded.has(id)) continue;
        const child = this.composerData(id);
        if (!child) continue;
        seen.add(id);
        out.push({ id, session: this.buildSession(id, child) });
        queue.push({ id, data: child });
      }
    }
    return out;
  }

  // Subagent composers a retried `task_v2` spawn abandoned. They are still
  // listed in `subagentComposerIds`, so without this they would each export as
  // a duplicate child transcript of the attempt that replaced them.
  private supersededIds(composerId: string): Set<string> {
    const out = new Set<string>();
    for (const b of this.bubbleRows(composerId)) {
      const extra = b.toolFormerData?.additionalData?.["supersededSubagentComposerIds"];
      if (Array.isArray(extra)) for (const id of extra) if (typeof id === "string") out.add(id);
    }
    return out;
  }

  // Every bubble stored for a composer, parsed. Read in one query rather than
  // one per header: the ids in `fullConversationHeadersOnly` do not reliably
  // name the rows on disk (see `alignBubbles`), so the rows have to be in hand
  // before the conversation can be assembled.
  private bubbleRows(composerId: string): Bubble[] {
    const cached = this.rowCache.get(composerId);
    if (cached) return cached;
    const rows = this.db
      .prepare("SELECT value FROM cursorDiskKV WHERE key LIKE ? ESCAPE '\\'")
      .all(`bubbleId:${escapeLike(composerId)}:%`) as Array<{ value: unknown }>;
    const out: Bubble[] = [];
    for (const r of rows) {
      const raw =
        typeof r.value === "string" ? r.value : Buffer.from(r.value as Uint8Array).toString("utf-8");
      try {
        out.push(JSON.parse(raw) as Bubble);
      } catch {
        /* a bubble we cannot parse is one message lost, not a failed export */
      }
    }
    this.rowCache.set(composerId, out);
    return out;
  }

  // Pair each header with the bubble row it describes.
  //
  // The obvious lookup — `bubbleId:<composer>:<header.bubbleId>` — is not
  // reliable: on a session Cursor has restored from a checkpoint, the stored
  // rows carry regenerated ids and only a handful still match the header array
  // (5 of 88 in the probe session, while its subagent matched 99 of 99). The
  // conversation itself is intact; only the ids were rewritten. So resolve by
  // id first, then fall back to the bubble's own start time, which the header
  // and the row always agree on to the millisecond.
  //
  // Rows no header claims are kept, not dropped, and slotted in by time: they
  // are real events (in the probe, a cancelled shell command and one the user
  // rejected at the approval prompt) that the header array simply never caught
  // up with. Header order otherwise wins, exactly as the format intends.
  private alignBubbles(
    composerId: string,
    headers: BubbleHeader[],
  ): Array<{ header?: BubbleHeader; bubble: Bubble }> {
    const rows = this.bubbleRows(composerId);
    const byId = new Map<string, Bubble>();
    const byTime = new Map<number, Bubble[]>();
    for (const b of rows) {
      if (b.bubbleId) byId.set(b.bubbleId, b);
      const t = bubbleTime(b);
      if (t === undefined) continue;
      (byTime.get(t) ?? byTime.set(t, []).get(t)!).push(b);
    }

    const claimed = new Set<Bubble>();
    const entries: Array<{ seq: number; header?: BubbleHeader; bubble: Bubble }> = [];
    // Header start times, in order, so a leftover row can be slotted between
    // the two headers it falls between.
    const headerTimes: number[] = [];

    headers.forEach((h, i) => {
      const t = headerTime(h);
      headerTimes.push(t ?? Number.NEGATIVE_INFINITY);
      let b = h.bubbleId ? byId.get(h.bubbleId) : undefined;
      if (b && claimed.has(b)) b = undefined;
      if (!b && t !== undefined) b = (byTime.get(t) ?? []).find((x) => !claimed.has(x));
      if (!b) return;
      claimed.add(b);
      entries.push({ seq: i, header: h, bubble: b });
    });

    for (const b of rows) {
      if (claimed.has(b)) continue;
      const t = bubbleTime(b) ?? Number.POSITIVE_INFINITY;
      // Half a step past the last header that starts at or before it, so it
      // lands between its neighbours without displacing either.
      let before = 0;
      while (before < headerTimes.length && headerTimes[before]! <= t) before++;
      entries.push({ seq: before - 0.5, bubble: b });
    }

    entries.sort((a, b) => a.seq - b.seq);
    return entries.map(({ header, bubble }) => (header ? { header, bubble } : { bubble }));
  }

  private buildSession(composerId: string, data: ComposerData): NeutralSession {
    const headers = data.fullConversationHeadersOnly ?? [];
    const messages: NeutralMessage[] = [];
    const model = data.modelConfig?.modelName
      ? // Cursor stores a bare model id (`grok-4.6`); `NeutralSession.model` and
        // the catalog are keyed `<provider>/<model>`, so the provider is
        // recovered from the id.
        qualifyModel(data.modelConfig.modelName)
      : undefined;

    const aligned = this.alignBubbles(composerId, headers);
    // Session start: the header array's own first entry, except when a row no
    // header claimed sits earlier — everything on the timeline is measured from
    // here, and a later start would put the first messages at a negative offset.
    const startIso = [
      headers[0]?.createdAt ?? isoOf(data.createdAt, new Date(0).toISOString()),
      ...(aligned[0] ? [isoOf(bubbleTime(aligned[0].bubble), "")] : []),
    ]
      .filter(Boolean)
      .sort()[0]!;
    let lastIso = startIso;

    for (const { header: h, bubble: b } of aligned) {
      // Both the header and the bubble carry timings; the header is the one
      // Cursor renders from and carries `completedAtMs` more often, so it wins
      // where present — a leftover row has only its own.
      const started = h?.startedAtMs ?? b.startedAtMs;
      const completed = h?.completedAtMs ?? b.completedAtMs;
      const ts = isoOf(started, h?.createdAt ?? b.createdAt ?? lastIso);
      lastIso = isoOf(completed, ts);

      const blocks = this.blocksForBubble(b, ts, lastIso);
      if (!blocks.length) continue;

      const msg: NeutralMessage = { role: b.type === 1 ? "user" : "assistant", ts, blocks };
      // Every assistant turn ran on the composer's model; `usage` is left
      // absent rather than zeroed, so readers can tell "not recorded" from
      // "recorded as nothing" (§4.4 of the spec).
      if (model && msg.role === "assistant") msg.model = model;
      if (data.unifiedMode) msg.permissionMode = data.unifiedMode;
      messages.push(msg);
    }

    // Cursor has no permission modes and barely observable mode transitions, so
    // the band is one flat segment naming the session's mode rather than
    // invented switches (§4.2).
    const mode = data.unifiedMode || "agent";

    const session: NeutralSession = {
      uuid: composerId,
      sessionId: composerId,
      cwd: data.workspaceIdentifier?.uri?.fsPath ?? this.opts.projectRoot,
      // Cursor's app version is not in the conversation record. Reading
      // `product.json` would report the version at *export* time, not the one
      // that produced the session, so record nothing rather than something
      // misleading.
      version: "",
      branch: branchOf(data),
      branchSource: "snapshot",
      source: "cursor",
      firstTimestamp: startIso,
      lastTimestamp: lastIso,
      messages,
      modeTransitions: [{ t: 0, mode }],
      // The blocker, stated in the data rather than left for a reader to infer
      // from a suspicious run of zeros.
      usageAvailable: false,
    };
    if (data.name?.trim()) session.title = data.name.trim();
    const breakdown = contextBreakdownOf(data);
    if (breakdown) session.contextBreakdown = breakdown;
    return session;
  }

  // One bubble is exactly one of four things: a human turn, assistant text, a
  // thinking block, or a tool call fused with its result.
  private blocksForBubble(b: Bubble, ts: string, endTs: string): NeutralBlock[] {
    if (b.toolFormerData) return this.blocksForTool(b.toolFormerData, ts, endTs);

    // Thinking and spoken text land in separate bubbles in every case observed,
    // but nothing in the format says they must, so emit both rather than
    // letting one silently shadow the other.
    const out: NeutralBlock[] = [];
    if (b.thinking?.text?.trim()) out.push({ kind: "thinking", text: b.thinking.text, ts });
    // `type: 1` is the human's own turn; everything else on the transcript is
    // the model speaking. Cursor injects rules and skills into the system
    // prompt rather than as visible turns, so there is no `skill_prompt`
    // equivalent to separate out here (§4.6).
    if (b.text?.trim()) {
      out.push({ kind: b.type === 1 ? "user_text" : "assistant_text", text: b.text, ts });
    }
    return out;
  }

  // Split Cursor's fused call+result record into the `tool_use` / `tool_result`
  // pair every other source emits, joined by `toolCallId` so the ids still line
  // up downstream. Note the ids contain a literal newline
  // (`"call-…-44\nfc_…_7"`); they are carried through verbatim.
  private blocksForTool(t: ToolFormerData, ts: string, endTs: string): NeutralBlock[] {
    const name = t.name ?? "";
    const canonical =
      TOOL_MAP[name] ??
      (t.tool !== undefined ? TOOL_BY_ENUM[t.tool] : undefined) ??
      (name || "unknown");

    const params = parseObject(t.params);
    const rawArgs = parseObject(t.rawArgs);
    const result = parseObject(t.result);
    const extra = t.additionalData ?? {};

    const call: NeutralBlock = {
      kind: "tool_use",
      tool: canonical,
      displayTool: name || canonical,
      ts,
      input: normalizeInput(canonical, params, rawArgs),
    };
    if (t.toolCallId) call.id = t.toolCallId;

    // `edit_file_v2` carries a real line-level diff with both line numbers, so
    // the exporter's approximation from before/after strings is never needed —
    // this is the one place Cursor records more than the other sources.
    const diff = diffFrom(extra["precomputedDiff"]);
    if (diff) {
      call.diff = {
        file: String(call.input?.["file_path"] ?? ""),
        patch: diff.patch,
        additions: diff.additions,
        deletions: diff.deletions,
      };
    }

    // The spawning call names its child composer outright — no scrape of the
    // result prose, unlike the Claude Code path.
    if (canonical === "Agent") {
      const childId =
        (typeof extra["subagentComposerId"] === "string" ? extra["subagentComposerId"] : undefined) ??
        (typeof result["agentId"] === "string" ? result["agentId"] : undefined);
      if (childId) call.agentId = childId;
      // The spawn names the model the child ran on, which is not necessarily
      // the orchestrator's — and is the only place it is stated before the
      // child transcript is opened.
      const childModel = params["model"];
      if (typeof childModel === "string" && childModel) {
        call.subagentModel = qualifyModel(childModel);
      }
    }

    const blocks: NeutralBlock[] = [call];

    // `loading` is a call that never finished (the probe session was aborted
    // mid-run); emitting a result for it would invent one. A `pending` or
    // `cancelled` sandbox verdict in `additionalData` is Cursor's nearest thing
    // to a rejected tool call, and carries the reason it was blocked.
    const status = t.status ?? "";
    const sandbox = typeof extra["status"] === "string" ? extra["status"] : "";
    const blockReason = typeof extra["blockReason"] === "string" ? extra["blockReason"] : "";
    const rejected = status === "cancelled" || sandbox === "cancelled" || sandbox === "pending";
    if (status === "loading" && !rejected) return blocks;

    const isError = status === "error";
    const full = this.resultTextFor(t);
    const text = isError
      ? errorText(t.error) || resultText(t, result, extra, full)
      : rejected
        ? blockReason || "The tool call was cancelled before it ran."
        : resultText(t, result, extra, full);
    if (!text && !isError && !rejected) return blocks;

    blocks.push({
      kind: "tool_result",
      tool: canonical,
      displayTool: name || canonical,
      ts: endTs,
      text,
      ...(t.toolCallId ? { toolUseId: t.toolCallId } : {}),
      status: rejected ? "rejected" : isError ? "error" : "ok",
      outChars: text.length,
    });
    return blocks;
  }

  // The full result the model read, from the content-addressed `agentKv` blobs,
  // keyed by `toolCallId`. Needed because `toolFormerData.result` is a summary
  // stub for the tools that matter most: a `read_file_v2` records only
  // `{"totalLinesInFile": 114}`, never the text.
  private agentKvResults(): Map<string, string> {
    if (this.resultsByCallId) return this.resultsByCallId;
    const out = new Map<string, string>();
    this.resultsByCallId = out;
    let rows: Array<{ value: unknown }>;
    try {
      rows = this.db
        .prepare("SELECT value FROM cursorDiskKV WHERE key LIKE 'agentKv:blob:%'")
        .all() as Array<{ value: unknown }>;
    } catch {
      return out;
    }
    for (const r of rows) {
      // Most blobs are protobuf file-state nodes; only the ones that start with
      // `{` are the Vercel-AI-SDK messages, so skip the rest without decoding.
      const buf = typeof r.value === "string" ? Buffer.from(r.value, "utf-8") : Buffer.from(r.value as Uint8Array);
      if (buf[0] !== 0x7b) continue;
      let msg: { role?: string; content?: Array<{ toolCallId?: string; result?: unknown }> };
      try {
        msg = JSON.parse(buf.toString("utf-8"));
      } catch {
        continue;
      }
      if (msg.role !== "tool") continue;
      for (const c of msg.content ?? []) {
        if (!c.toolCallId || c.result === undefined) continue;
        out.set(c.toolCallId, typeof c.result === "string" ? c.result : JSON.stringify(c.result));
      }
    }
    return out;
  }

  private resultTextFor(t: ToolFormerData): string | undefined {
    return t.toolCallId ? this.agentKvResults().get(t.toolCallId) : undefined;
  }

  setup(): { project: SetupItem[]; user: SetupItem[] } {
    const home = os.homedir();
    return {
      project: readCursorSetup(path.join(this.opts.projectRoot, ".cursor")),
      user: [
        ...readCursorSetup(path.join(home, ".cursor")),
        // Cursor ships ~23 built-in skills in a directory of their own, next to
        // the user's. They are as much a part of the session's setup as the
        // hand-written ones, so list them together.
        ...readSkillDir(path.join(home, ".cursor", "skills-cursor")),
      ],
    };
  }
}

// The result text for the transcript: the untruncated `agentKv` copy when the
// join found one, else whatever Cursor kept on the bubble. `ripgrep_raw_search`
// leaves `result` empty and puts its match summary in `additionalData`, so that
// is the last fallback rather than rendering an empty result.
function resultText(
  t: ToolFormerData,
  result: Record<string, unknown>,
  extra: Record<string, unknown>,
  full: string | undefined,
): string {
  if (full) return full;
  if (typeof result["output"] === "string") return result["output"];
  if (typeof result["contents"] === "string") return result["contents"];
  if (t.result && t.result !== "{}") return t.result;
  const summary = { ...extra };
  delete summary["precomputedDiff"];
  return Object.keys(summary).length ? JSON.stringify(summary) : "";
}

// `error` is a JSON string; the model-visible message is the one the transcript
// should show, since it is what the conversation actually continued from.
function errorText(raw: string | undefined): string {
  const e = parseObject(raw);
  const msg = e["modelVisibleErrorMessage"] ?? e["clientVisibleErrorMessage"];
  return typeof msg === "string" ? msg : raw ? String(raw) : "";
}

// Cursor's `precomputedDiff` is already a line-level diff with both line
// numbers, so it converts straight to a unified patch — no reconstruction from
// before/after strings, and the counts come out exact.
function diffFrom(raw: unknown): { patch: string; additions: number; deletions: number } | null {
  if (!raw || typeof raw !== "object") return null;
  const lines = (raw as { lines?: Array<{ type?: string; content?: string }> }).lines;
  if (!Array.isArray(lines) || !lines.length) return null;
  const out: string[] = [];
  let additions = 0;
  let deletions = 0;
  for (const l of lines) {
    const text = l.content ?? "";
    if (l.type === "added") {
      out.push("+" + text);
      additions++;
    } else if (l.type === "removed") {
      out.push("-" + text);
      deletions++;
    } else {
      out.push(" " + text);
    }
  }
  return { patch: out.join("\n"), additions, deletions };
}

// Cursor records the branch at session time — unlike OpenCode, which records
// none — so this is a real snapshot rather than a reading of the working tree.
function branchOf(data: ComposerData): string {
  for (const repo of data.trackedGitRepos ?? []) {
    const name = repo.branches?.[0]?.branchName;
    if (name) return name;
  }
  return "unknown";
}

function contextBreakdownOf(data: ComposerData): ContextBreakdown | undefined {
  const b = data.promptTokenBreakdown;
  const categories = (b?.categories ?? [])
    .filter((c) => (c.estimatedTokens ?? 0) > 0)
    .map((c) => ({ id: c.id ?? "", label: c.label ?? c.id ?? "", tokens: c.estimatedTokens ?? 0 }));
  const used = b?.totalUsedTokens ?? data.contextTokensUsed ?? 0;
  const max = b?.maxTokens ?? data.contextTokenLimit ?? 0;
  if (!used && !categories.length) return undefined;
  return { usedTokens: used, maxTokens: max, categories };
}

// Cursor writes a bare model id where the rest of the pipeline expects
// `<provider>/<model>`. Map the ids Cursor actually offers onto their provider
// so the catalog lookup and the model colours resolve; anything unrecognised is
// left bare, which `resolveModel` still handles.
function qualifyModel(raw: string): string {
  // Cursor's internal ids wrap the real model in its own prefix and reasoning
  // effort (`cursor-grok-4.6-high`). Unwrap them, so a subagent spawn and the
  // session that spawned it resolve to one model rather than two — otherwise
  // the report's legend lists the same model twice under different names.
  const id = /^cursor-/i.test(raw)
    ? raw.replace(/^cursor-/i, "").replace(/-(high|medium|low|max|fast|thinking)$/i, "")
    : raw;
  if (/^(grok|xai)/i.test(id)) return `xai/${id}`;
  if (/^(gpt|o[34]|codex)/i.test(id)) return `openai/${id}`;
  if (/^(claude|sonnet|opus|haiku)/i.test(id)) return `anthropic/${id}`;
  if (/^gemini/i.test(id)) return `google/${id}`;
  if (/^(composer|cursor|auto)/i.test(id)) return `cursor/${id}`;
  return id;
}

// --- Setup panel (§3.6) ---

// Cursor's configuration dirs mirror Claude Code's `agents/` + `skills/`
// layout, and add `commands/` and `rules/`. Rules are `.mdc` files injected
// into the system prompt — the thing Cursor users actually configure, and the
// reason `SetupItem.kind` gained a `rule`.
function readCursorSetup(dir: string): SetupItem[] {
  if (!fs.existsSync(dir)) return [];
  return [
    ...readMdDir(path.join(dir, "agents"), "agent"),
    ...readSkillDir(path.join(dir, "skills")),
    ...readMdDir(path.join(dir, "commands"), "command"),
    ...readMdDir(path.join(dir, "rules"), "rule", ".mdc"),
  ];
}

// A skills dir holds either `<name>/SKILL.md` or a flat `<name>.md`.
function readSkillDir(dir: string): SetupItem[] {
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
    const fm = frontmatter(file);
    items.push({
      kind: "skill",
      name: fm.name || entry.name.replace(/\.md$/, ""),
      description: fm.description || "",
    });
  }
  return items;
}

function readMdDir(dir: string, kind: SetupItem["kind"], ext = ".md"): SetupItem[] {
  if (!fs.existsSync(dir)) return [];
  const items: SetupItem[] = [];
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(ext)).sort()) {
    const fm = frontmatter(path.join(dir, f));
    items.push({
      kind,
      name: fm.name || f.slice(0, -ext.length),
      description: fm.description || "",
    });
  }
  return items;
}

// YAML frontmatter, read for `name` / `description` only. Cursor's `SKILL.md`
// uses the same shape Claude Code does, including folded (`>-`) descriptions
// spanning several indented lines.
function frontmatter(file: string): { name?: string; description?: string } {
  try {
    const m = fs.readFileSync(file, "utf-8").match(/^---\n([\s\S]*?)\n---/);
    if (!m) return {};
    const out: { name?: string; description?: string } = {};
    const lines = m[1]!.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const c = line.indexOf(":");
      if (c === -1 || /^\s/.test(line)) continue;
      const key = line.slice(0, c).trim();
      if (key !== "name" && key !== "description") continue;
      let value = line.slice(c + 1).trim();
      // A folded/literal scalar (`>-`, `|`) puts the text on the indented lines
      // that follow; join them into one line rather than reporting an empty
      // description, which is how most Cursor skills are written.
      if (value === ">" || value === ">-" || value === "|" || value === "|-") {
        const parts: string[] = [];
        while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]!)) parts.push(lines[++i]!.trim());
        value = parts.join(" ");
      }
      out[key] = value.replace(/^["']|["']$/g, "");
    }
    return out;
  } catch {
    return {};
  }
}
