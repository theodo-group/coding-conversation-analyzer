// sources/copilot — read GitHub Copilot CLI sessions into the neutral
// intermediate.
//
// Copilot CLI keeps one directory per session under `~/.copilot/session-state/`:
// a `workspace.yaml` (cwd, git root, branch, title) and an append-only
// `events.jsonl` log. See `docs/copilot-export-spec.md`. Four things here differ
// from the other adapters:
//
//   1. The log is a stream of typed events, not messages. A tool call is
//      announced in `assistant.message.toolRequests` and its result arrives as a
//      separate `tool.execution_complete`, joined by `toolCallId`.
//   2. Subagents share the parent's log. Their events carry an `agentId`
//      (1.0.x) or only a `parentToolCallId` naming the spawning call (0.0.x),
//      and are split out into their own transcripts here.
//   3. The log carries no per-call token usage. That lives in a separate SQLite
//      store, `~/.copilot/session-store.db`, one `assistant_usage_events` row per
//      API call, and is joined back onto the messages by agent and timestamp.
//      Sessions that predate the store have no rows; those are flagged
//      `usageAvailable: false` rather than carrying zeros.
//   4. Model ids are Copilot's own (`claude-sonnet-4.5`, `gpt-5.6-luna`). Ids
//      the checked-in catalog knows are used as-is; the rest are priced from
//      models.dev's `github-copilot` provider and embedded in the sidecar.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { DatabaseSync } from "node:sqlite";
import { MODELS, resolveModel, withCatalog, type ModelCatalog } from "../models.ts";
import { readSetupDir } from "./claude.ts";
import { defaultModelsDevFile, ModelsDevCache } from "./models-dev.ts";
import { openDatabase } from "./sqlite.ts";
import type {
  ContextBreakdown,
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

// --- Record shapes ---

interface ToolRequest {
  toolCallId?: string;
  name?: string;
  arguments?: Record<string, unknown>;
}

interface EventData {
  // session.start
  copilotVersion?: string;
  selectedModel?: string;
  context?: { cwd?: string; gitRoot?: string; branch?: string };
  // session.model_change
  newModel?: string;
  // user.message / permission.requested
  content?: string;
  agentMode?: string | null;
  // assistant.message
  model?: string;
  reasoningText?: string;
  toolRequests?: ToolRequest[];
  parentToolCallId?: string;
  // tool.execution_complete
  toolCallId?: string;
  success?: boolean;
  result?: { content?: string; detailedContent?: string } | null;
  error?: { message?: string; code?: string } | null;
  // subagent.started
  agentName?: string;
  // session.shutdown
  currentModel?: string;
  currentTokens?: number;
  systemTokens?: number;
  conversationTokens?: number;
  toolDefinitionsTokens?: number;
}

interface CopilotEvent {
  type?: string;
  timestamp?: string;
  // Set on every event a subagent emits (1.0.x). 0.0.x tagged only
  // `data.parentToolCallId`.
  agentId?: string;
  data?: EventData;
}

// One row of `session-store.db`'s `assistant_usage_events`.
interface UsageRow {
  agent_id: string | null;
  parent_tool_call_id: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  created_at: string | null;
}

// --- Tool mapping ---

// Copilot's tool names → the canonical names the exporter formats and buckets
// against. Anything else (`report_intent`, `read_bash`, `sql`, MCP tools, …)
// keeps its own name and lands in `other`.
const TOOL_MAP: Record<string, string> = {
  view: "Read",
  create: "Write",
  edit: "Edit",
  bash: "Bash",
  glob: "Glob",
  grep: "Grep",
  task: "Agent",
  web_fetch: "WebFetch",
};

// Copilot's tool inputs → the canonical snake_case keys.
function normalizeInput(canonical: string, args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...args };
  const rename = (from: string, to: string): void => {
    if (from in out) {
      out[to] = out[from];
      delete out[from];
    }
  };
  switch (canonical) {
    case "Read": {
      rename("path", "file_path");
      // `view_range: [start, end]` (1-based, end inclusive; -1 for EOF) is
      // Claude Code's offset/limit pair in another shape.
      const range = out["view_range"];
      if (Array.isArray(range) && typeof range[0] === "number") {
        out["offset"] = range[0];
        if (typeof range[1] === "number" && range[1] >= range[0]) out["limit"] = range[1] - range[0] + 1;
        delete out["view_range"];
      }
      break;
    }
    case "Write":
      rename("path", "file_path");
      rename("file_text", "content");
      break;
    case "Edit":
      rename("path", "file_path");
      rename("old_str", "old_string");
      rename("new_str", "new_string");
      break;
    case "Agent":
      rename("agent_type", "subagent_type");
      break;
  }
  return out;
}

// --- Models ---

// The key a message's model is recorded under. Copilot writes Anthropic ids
// with dots (`claude-sonnet-4.5`) where the catalog uses dashes; an id the
// catalog knows either way is kept bare, so a Copilot export prices and colours
// a model exactly as a Claude Code export does. Anything else is qualified with
// the `github-copilot` provider it is priced under on models.dev.
function modelKey(id: string): string {
  if (MODELS[id]) return id;
  const dashed = id.replace(/\./g, "-");
  if (/^claude-/.test(id) && MODELS[dashed]) return dashed;
  return `github-copilot/${id}`;
}

// --- Helpers ---

function readEvents(file: string): CopilotEvent[] {
  const out: CopilotEvent[] = [];
  for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // A session still being written can end on a partial line.
    }
  }
  return out;
}

// `workspace.yaml` is flat: `key: value` lines, plus block scalars (`|-`) for a
// multi-line name. Read just that, rather than pulling in a YAML parser.
function readWorkspace(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  let text: string;
  try {
    text = fs.readFileSync(file, "utf-8");
  } catch {
    return out;
  }
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(/^([A-Za-z_][\w-]*):\s?(.*)$/);
    if (!m) continue;
    const key = m[1]!;
    const value = m[2]!.trim();
    if (/^[|>][-+]?$/.test(value)) {
      const block: string[] = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]!)) {
        block.push(lines[++i]!.replace(/^ {2}/, ""));
      }
      out[key] = block.join("\n");
    } else {
      out[key] = value.replace(/^(["'])(.*)\1$/, "$2");
    }
  }
  return out;
}

function realpath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function expandHome(p: string): string {
  return path.resolve(p.replace(/^~(?=$|\/)/, os.homedir()));
}

// Copilot's edit/create results carry the real unified diff it applied
// (`diff --git …` / `@@ … @@` / `+`/`-` lines), so the exporter's approximation
// from before/after strings is never needed.
function exactDiff(file: string, detailed: string | undefined): ExactDiff | undefined {
  if (!detailed || !detailed.includes("@@")) return undefined;
  let additions = 0;
  let deletions = 0;
  for (const line of detailed.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions++;
    else if (line.startsWith("-")) deletions++;
  }
  return { file, patch: detailed.replace(/^\n/, ""), additions, deletions };
}

function msOf(iso: string | null | undefined): number {
  const t = iso ? new Date(iso).getTime() : NaN;
  return isNaN(t) ? 0 : t;
}

// --- Adapter ---

export interface CopilotAdapterOptions {
  projectRoot: string;
  // Other roots the same project's sessions may be keyed under (git worktrees,
  // Conductor workspaces).
  extraRoots?: string[];
  // Overrides `~/.copilot` (mirrors `--claude-dir`).
  copilotDir?: string;
  // Overrides the models.dev catalog used to price models the checked-in one
  // doesn't know.
  modelsDevFile?: string;
}

// An assistant message's usage row is written a few milliseconds before the
// event itself; anything further apart than this is not the same API call.
const USAGE_MATCH_MS = 2000;

export class CopilotAdapter implements SourceAdapter {
  readonly source = "copilot" as const;
  readonly origin: string;
  private readonly copilotDir: string;
  private readonly sessionsDir: string;
  private readonly roots: Set<string>;
  private readonly catalog: ModelsDevCache;
  private readonly opts: CopilotAdapterOptions;
  private db: DatabaseSync | null | undefined;

  constructor(opts: CopilotAdapterOptions) {
    this.opts = opts;
    this.copilotDir = opts.copilotDir ? expandHome(opts.copilotDir) : path.join(os.homedir(), ".copilot");
    this.sessionsDir = path.join(this.copilotDir, "session-state");
    if (!fs.existsSync(this.sessionsDir)) {
      throw new Error(`no GitHub Copilot CLI sessions at ${this.sessionsDir}`);
    }
    this.origin = this.sessionsDir;
    this.roots = new Set([opts.projectRoot, ...(opts.extraRoots ?? [])].map(realpath));
    this.catalog = new ModelsDevCache(opts.modelsDevFile ?? defaultModelsDevFile());
  }

  list(): SourceSessionRef[] {
    const refs: SourceSessionRef[] = [];
    for (const entry of fs.readdirSync(this.sessionsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(this.sessionsDir, entry.name);
      const events = path.join(dir, "events.jsonl");
      // A session that never got past startup leaves only `workspace.yaml`.
      if (!fs.existsSync(events)) continue;
      // A session started in a subdirectory still belongs to the repo it ran
      // in, so the git root is matched first.
      const ws = readWorkspace(path.join(dir, "workspace.yaml"));
      const where = ws["git_root"] || ws["cwd"];
      if (!where || !this.roots.has(realpath(where))) continue;
      refs.push({
        uuid: entry.name,
        // The session id is a UUID; the `cp` tag keeps its stem unambiguous
        // next to Claude Code's in a mixed-source directory.
        prefix: "cp" + entry.name.replace(/-/g, "").slice(0, 8),
        mtime: fs.statSync(events).mtimeMs,
      });
    }
    return refs;
  }

  load(ref: SourceSessionRef): NeutralConversation {
    const dir = path.join(this.sessionsDir, ref.uuid);
    const events = readEvents(path.join(dir, "events.jsonl"));
    const ws = readWorkspace(path.join(dir, "workspace.yaml"));

    // Split the shared log into the main thread and one stream per subagent.
    const streams = new Map<string, CopilotEvent[]>();
    const keyOf = (e: CopilotEvent): string => e.agentId ?? e.data?.parentToolCallId ?? "";
    for (const e of events) {
      const k = keyOf(e);
      (streams.get(k) ?? streams.set(k, []).get(k)!).push(e);
    }

    // Which transcript each spawning call started, and the model it ran on.
    // 1.0.x says so in `subagent.started`; 0.0.x's subagent stream is keyed by
    // the spawning call's own id.
    const childBySpawn = new Map<string, { id: string; model?: string }>();
    for (const e of events) {
      if (e.type !== "subagent.started" || !e.agentId || !e.data?.toolCallId) continue;
      childBySpawn.set(e.data.toolCallId, {
        id: e.agentId,
        ...(e.data.model ? { model: e.data.model } : {}),
      });
    }
    const announced = new Set([...childBySpawn.values()].map((c) => c.id));
    for (const k of streams.keys()) {
      if (k && !announced.has(k)) childBySpawn.set(k, { id: k });
    }

    const usage = this.usageRows(ref.uuid);
    const usageAvailable = usage.length > 0;
    const usageByStream = new Map<string, UsageRow[]>();
    for (const r of usage) {
      const k = r.agent_id ?? r.parent_tool_call_id ?? "";
      (usageByStream.get(k) ?? usageByStream.set(k, []).get(k)!).push(r);
    }

    const start = events.find((e) => e.type === "session.start")?.data;
    const models: ModelCatalog = {};
    const meta = {
      cwd: start?.context?.cwd || ws["cwd"] || this.opts.projectRoot,
      version: start?.copilotVersion ?? "",
      branch: ws["branch"] || start?.context?.branch || "unknown",
      startModel: start?.selectedModel,
    };

    const session = this.toSession(
      ref.uuid,
      streams.get("") ?? [],
      usageByStream.get("") ?? [],
      usageAvailable,
      meta,
      models,
      childBySpawn,
    );
    // A real title only: `summary` is generated (0.0.x), `name` is the first
    // prompt unless the user named the session.
    const title = ws["summary"] || (ws["user_named"] === "true" ? ws["name"] : "");
    if (title?.trim()) session.title = title.trim();

    const shutdown = events.filter((e) => e.type === "session.shutdown").pop()?.data;
    if (!usageAvailable && shutdown) {
      const breakdown = this.contextBreakdownOf(shutdown, models);
      if (breakdown) session.contextBreakdown = breakdown;
    }

    const subagents: NeutralTranscript[] = [];
    for (const [k, stream] of streams) {
      if (!k) continue;
      const id = childBySpawn.get(k)?.id ?? k;
      const childModel = [...childBySpawn.values()].find((c) => c.id === id)?.model;
      subagents.push({
        id,
        session: this.toSession(
          id,
          stream,
          usageByStream.get(k) ?? [],
          usageAvailable,
          { ...meta, startModel: childModel ?? meta.startModel },
          models,
          childBySpawn,
        ),
      });
    }

    if (Object.keys(models).length) session.models = models;
    return { session, subagents, workflows: [] };
  }

  // One event stream (the main thread, or one subagent) → a neutral session.
  private toSession(
    uuid: string,
    events: CopilotEvent[],
    usage: UsageRow[],
    usageAvailable: boolean,
    meta: { cwd: string; version: string; branch: string; startModel: string | undefined },
    models: ModelCatalog,
    childBySpawn: Map<string, { id: string; model?: string }>,
  ): NeutralSession {
    const messages: NeutralMessage[] = [];
    const modeTransitions: Array<{ t: number; mode: string }> = [];
    const pending = new Map<string, NeutralBlock>();
    let model = meta.startModel;
    let firstTimestamp = "";
    let lastTimestamp = "";
    // Consecutive tool results share one user message, the way Claude Code
    // returns a turn's parallel results together.
    let results: NeutralMessage | null = null;
    const assistants: NeutralMessage[] = [];

    const key = (id: string): string => {
      const k = modelKey(id);
      this.recordModel(models, k, id);
      return k;
    };
    const toSec = (ts: string): number => (msOf(ts) - msOf(firstTimestamp)) / 1000;
    const setMode = (mode: string | null | undefined, ts: string): void => {
      if (!mode) return;
      const prev = modeTransitions[modeTransitions.length - 1];
      if (!prev || prev.mode !== mode) modeTransitions.push({ t: toSec(ts), mode });
    };

    for (const e of events) {
      const ts = e.timestamp ?? lastTimestamp;
      if (e.timestamp) {
        if (!firstTimestamp) firstTimestamp = e.timestamp;
        lastTimestamp = e.timestamp;
      }
      const d = e.data ?? {};

      switch (e.type) {
        case "session.start":
          if (d.selectedModel) model = d.selectedModel;
          break;

        case "session.model_change":
          if (d.newModel) model = d.newModel;
          break;

        case "permission.requested":
          setMode(d.agentMode, ts);
          break;

        case "user.message": {
          results = null;
          setMode(d.agentMode, ts);
          // `content` is what the user typed; `transformedContent` is the same
          // text wrapped in injected context (the current datetime, …).
          if (!d.content?.trim()) break;
          messages.push({ role: "user", ts, blocks: [{ kind: "user_text", text: d.content }] });
          break;
        }

        case "assistant.message": {
          results = null;
          const msg: NeutralMessage = { role: "assistant", ts, blocks: [] };
          const m = d.model ?? model;
          if (m) msg.model = key(m);
          const mode = modeTransitions[modeTransitions.length - 1]?.mode;
          if (mode) msg.permissionMode = mode;
          if (d.reasoningText?.trim()) msg.blocks.push({ kind: "thinking", text: d.reasoningText });
          if (d.content?.trim()) msg.blocks.push({ kind: "assistant_text", text: d.content });
          for (const req of d.toolRequests ?? []) {
            const native = req.name ?? "unknown";
            const canonical = TOOL_MAP[native] ?? native;
            const block: NeutralBlock = {
              kind: "tool_use",
              tool: canonical,
              displayTool: native,
              input: normalizeInput(canonical, req.arguments ?? {}),
            };
            if (req.toolCallId) {
              block.id = req.toolCallId;
              pending.set(req.toolCallId, block);
              const child = childBySpawn.get(req.toolCallId);
              if (canonical === "Agent" && child) {
                block.agentId = child.id;
                if (child.model) block.subagentModel = key(child.model);
              }
            }
            msg.blocks.push(block);
          }
          // Kept even when empty: it still stands for an API call, and its
          // usage drives cost and the context curve.
          messages.push(msg);
          assistants.push(msg);
          break;
        }

        case "tool.execution_complete": {
          const call = d.toolCallId ? pending.get(d.toolCallId) : undefined;
          if (d.toolCallId) pending.delete(d.toolCallId);
          const canonical = call?.tool ?? "unknown";
          // `denied` is the permission system refusing the call, which is what
          // the other sources call a rejection; any other failure is an error.
          const rejected = d.error?.code === "denied" || d.error?.code === "rejected";
          const text = d.success === false ? (d.error?.message ?? "") : (d.result?.content ?? "");
          if (call && d.success !== false && (canonical === "Edit" || canonical === "Write")) {
            const diff = exactDiff(String(call.input?.["file_path"] ?? ""), d.result?.detailedContent);
            if (diff) call.diff = diff;
          }
          const block: NeutralBlock = {
            kind: "tool_result",
            tool: canonical,
            ...(call?.displayTool ? { displayTool: call.displayTool } : {}),
            text,
            status: rejected ? "rejected" : d.success === false ? "error" : "ok",
            outChars: text.length,
          };
          if (d.toolCallId) block.toolUseId = d.toolCallId;
          if (!results) {
            results = { role: "user", ts, blocks: [] };
            messages.push(results);
          }
          results.blocks.push(block);
          break;
        }
      }
    }

    // The mode is only stated once something asks for it (a prompt, a
    // permission request), so the band starts in Copilot's default before that.
    if (!modeTransitions.length) modeTransitions.push({ t: 0, mode: "interactive" });
    else if (modeTransitions[0]!.mode === "interactive") modeTransitions[0]!.t = 0;
    else if (modeTransitions[0]!.t > 0) modeTransitions.unshift({ t: 0, mode: "interactive" });
    this.attachUsage(assistants, usage);

    const session: NeutralSession = {
      uuid,
      sessionId: uuid,
      cwd: meta.cwd,
      version: meta.version,
      branch: meta.branch,
      branchSource: "snapshot",
      source: "copilot",
      firstTimestamp,
      lastTimestamp,
      messages,
      modeTransitions,
    };
    if (!usageAvailable) session.usageAvailable = false;
    return session;
  }

  // Pair each API call's usage row with the assistant message it produced. Both
  // are in call order within one agent, and a row is stamped a few ms before its
  // message, so a merge walk on time is exact — and skips a call that produced
  // no message (an abort) instead of shifting every later pairing by one.
  private attachUsage(assistants: NeutralMessage[], rows: UsageRow[]): void {
    let i = 0;
    let j = 0;
    while (i < rows.length && j < assistants.length) {
      const row = rows[i]!;
      const dt = msOf(assistants[j]!.ts) - msOf(row.created_at);
      if (Math.abs(dt) <= USAGE_MATCH_MS) {
        assistants[j]!.usage = usageOf(row);
        i++;
        j++;
      } else if (dt > 0) {
        i++;
      } else {
        j++;
      }
    }
  }

  // Per-call usage for one session, or none: the store only exists from
  // Copilot CLI 1.0.x on, and a session from before it has no rows.
  private usageRows(sessionId: string): UsageRow[] {
    if (this.db === undefined) {
      const file = path.join(this.copilotDir, "session-store.db");
      try {
        this.db = fs.existsSync(file) ? openDatabase(file) : null;
      } catch {
        this.db = null;
      }
    }
    if (!this.db) return [];
    try {
      return this.db
        .prepare(
          `SELECT agent_id, parent_tool_call_id, input_tokens, output_tokens,
                  cache_read_tokens, cache_write_tokens, created_at
             FROM assistant_usage_events WHERE session_id = ? ORDER BY id`,
        )
        .all(sessionId) as unknown as UsageRow[];
    } catch {
      return [];
    }
  }

  // Record a price/limit entry for a model the built-in catalog doesn't know.
  private recordModel(into: ModelCatalog, key: string, id: string): void {
    if (into[key] || MODELS[key]) return;
    const entry = this.catalog.lookup("github-copilot", id);
    if (!entry) return;
    // models.dev omits a cache price the provider doesn't bill separately; that
    // is a zero, not a field to derive from the input price.
    const cost = { ...entry.cost, cache_read: entry.cost.cache_read ?? 0, cache_write: entry.cost.cache_write ?? 0 };
    into[key] = { ...entry, id: key, cost };
  }

  // What filled the context window when the session shut down, as Copilot
  // counted it. Only used when there is no per-call usage to draw from.
  private contextBreakdownOf(s: EventData, models: ModelCatalog): ContextBreakdown | undefined {
    const categories = [
      { id: "system", label: "System prompt", tokens: s.systemTokens ?? 0 },
      { id: "tools", label: "Tool definitions", tokens: s.toolDefinitionsTokens ?? 0 },
      { id: "conversation", label: "Conversation", tokens: s.conversationTokens ?? 0 },
    ].filter((c) => c.tokens > 0);
    const used = s.currentTokens ?? 0;
    if (!used && !categories.length) return undefined;
    const max = s.currentModel ? resolveModel(modelKey(s.currentModel), withCatalog(models)).limit.context : 0;
    return { usedTokens: used, maxTokens: max, categories };
  }

  // Custom agents and skills, in the layout Copilot CLI reads them from:
  // `.github/{agents,skills}` in the repo and `~/.copilot/{agents,skills}`.
  setup(): { project: SetupItem[]; user: SetupItem[] } {
    // Copilot names agent files `<name>.agent.md`.
    const read = (dir: string): SetupItem[] =>
      readSetupDir(dir).map((i) => (i.kind === "agent" ? { ...i, name: i.name.replace(/\.agent$/, "") } : i));
    return {
      project: read(path.join(this.opts.projectRoot, ".github")),
      user: read(this.copilotDir),
    };
  }
}

// `input_tokens` is the whole prompt, cache reads and writes included; the
// neutral `in` is the uncached remainder.
function usageOf(r: UsageRow): Usage {
  const cr = r.cache_read_tokens ?? 0;
  const cw = r.cache_write_tokens ?? 0;
  return {
    in: Math.max(0, (r.input_tokens ?? 0) - cr - cw),
    out: r.output_tokens ?? 0,
    cw,
    cr,
  };
}
