// sources/claude — read Claude Code's jsonl transcripts into the neutral
// intermediate. Everything Claude-specific lives here: the `~/.claude/projects`
// layout, the jsonl line types, the string-vs-array content split, and the
// `agentId:` scrape that links an Agent/Task spawn to its subagent transcript.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
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

interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  name?: string;
  id?: string;
  input?: unknown;
  content?: string | Array<{ type?: string; text?: string }>;
  is_error?: boolean;
  tool_use_id?: string;
}

interface RawUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

interface JsonlLine {
  type?: string;
  message?: {
    role?: string;
    content?: string | ContentBlock[];
    model?: string;
    usage?: RawUsage;
  };
  timestamp?: string;
  gitBranch?: string;
  cwd?: string;
  version?: string;
  sessionId?: string;
  permissionMode?: string;
  toolUseResult?: unknown;
}

// Line types that carry session metadata but no conversation content.
const SKIP_TYPES = new Set([
  "progress",
  "system",
  "queue-operation",
  "file-history-snapshot",
]);

function normUsage(u: RawUsage | undefined): Usage {
  return {
    in: u?.input_tokens ?? 0,
    out: u?.output_tokens ?? 0,
    cw: u?.cache_creation_input_tokens ?? 0,
    cr: u?.cache_read_input_tokens ?? 0,
  };
}

function readLines(filePath: string): string[] {
  return fs
    .readFileSync(filePath, "utf-8")
    .split("\n")
    .filter((l) => l.trim());
}

// Text of a tool_result's content, as the transcript renders it.
function resultText(content: ContentBlock["content"]): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => c.text || "").join("\n");
  return "";
}

// Size of a tool result for the simulator's context-weight apportioning. Falls
// back through the shapes a result can take so a structured (non-text) result
// still contributes its real weight rather than zero.
function resultSize(b: ContentBlock, toolUseResult: unknown): number {
  if (typeof b.content === "string") return b.content.length;
  if (Array.isArray(b.content)) return b.content.map((c) => c.text || "").join("\n").length;
  if (b.content) return JSON.stringify(b.content).length;
  if (toolUseResult) return JSON.stringify(toolUseResult).length;
  return 0;
}

// One jsonl transcript → a neutral session. `uuid` names the export file.
export function parseJsonl(lines: string[], uuid: string): NeutralSession {
  const messages: NeutralMessage[] = [];
  const modeTransitions: Array<{ t: number; mode: string }> = [];
  const branchCounts: Record<string, number> = {};

  let firstTimestamp = "";
  let lastTimestamp = "";
  let cwd = "";
  let version = "";
  let sessionId = "";

  // tool_use id → the block it produced, so its result can name the tool and a
  // spawn can be tagged with the subagent id its result announces.
  const pendingTools = new Map<string, NeutralBlock>();

  const toSec = (ts: string): number =>
    firstTimestamp ? (new Date(ts).getTime() - new Date(firstTimestamp).getTime()) / 1000 : 0;

  for (const line of lines) {
    let obj: JsonlLine;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

    // Session metadata is stamped on every line, including ones carrying no
    // conversation content — read it before any skip.
    if (obj.timestamp) {
      if (!firstTimestamp) firstTimestamp = obj.timestamp;
      lastTimestamp = obj.timestamp;
    }
    if (obj.cwd) cwd = obj.cwd;
    if (obj.version) version = obj.version;
    if (obj.sessionId) sessionId = obj.sessionId;
    if (obj.gitBranch) branchCounts[obj.gitBranch] = (branchCounts[obj.gitBranch] || 0) + 1;
    if (obj.permissionMode && obj.timestamp) {
      const prev = modeTransitions[modeTransitions.length - 1];
      if (!prev || prev.mode !== obj.permissionMode) {
        modeTransitions.push({ t: toSec(obj.timestamp), mode: obj.permissionMode });
      }
    }

    if (SKIP_TYPES.has(obj.type || "")) continue;
    const msg = obj.message;
    if (!msg?.role) continue;

    const role = msg.role === "assistant" ? "assistant" : "user";
    const out: NeutralMessage = { role, ts: obj.timestamp ?? "", blocks: [] };
    if (msg.model) out.model = msg.model;
    if (msg.usage) out.usage = normUsage(msg.usage);
    if (obj.permissionMode) out.permissionMode = obj.permissionMode;

    // Every message is kept, even one that renders to nothing: an assistant
    // message with no visible content still reports the token usage of the API
    // call that produced it, and that usage drives cost and the context curve.
    messages.push(out);

    // String content is a whole message in one piece: a human prompt, an async
    // subagent report, or one of the local-command echoes Claude Code injects.
    if (typeof msg.content === "string") {
      const c = msg.content;
      if (c.trim()) {
        const head = c.trimStart();
        const kind = head.startsWith("<task-notification>")
          ? "notification"
          : head.startsWith("<command-message>")
            ? "skill_call"
            : head.startsWith("<command-name>") || head.startsWith("<local-command-caveat>")
              ? "local_command"
              : head.startsWith("Base directory for this skill:")
                ? "skill_prompt"
                : "user_text";
        out.blocks.push({ kind, text: c });
      }
      continue;
    }
    if (!Array.isArray(msg.content)) continue;

    for (const b of msg.content) {
      switch (b.type) {
        case "thinking":
          if (b.thinking) out.blocks.push({ kind: "thinking", text: b.thinking });
          break;

        case "text": {
          if (!b.text?.trim()) break;
          if (role === "assistant") {
            out.blocks.push({ kind: "assistant_text", text: b.text });
          } else if (b.text.trimStart().startsWith("Base directory for this skill:")) {
            out.blocks.push({ kind: "skill_prompt", text: b.text });
          } else {
            out.blocks.push({ kind: "user_text", text: b.text });
          }
          break;
        }

        case "tool_use": {
          // Claude Code's tool names and snake_case input keys *are* the
          // canonical ones the exporter formats against — nothing to map.
          const block: NeutralBlock = { kind: "tool_use" };
          if (b.name !== undefined) block.tool = b.name;
          if (b.id) block.id = b.id;
          if (typeof b.input === "object" && b.input !== null) {
            block.input = b.input as Record<string, unknown>;
          }
          out.blocks.push(block);
          if (b.id) pendingTools.set(b.id, block);
          break;
        }

        case "tool_result": {
          const spawn = b.tool_use_id ? pendingTools.get(b.tool_use_id) : undefined;
          if (b.tool_use_id) pendingTools.delete(b.tool_use_id);
          const raw = resultText(b.content);
          const rejected = obj.toolUseResult === "User rejected tool use";

          // An Agent/Task result announces the subagent it launched
          // ("…agentId: <id>…"); that id is the stem of the subagent's exported
          // transcript, so tagging the spawn with it lets the viewer link across.
          if (spawn && (spawn.tool === "Agent" || spawn.tool === "Task")) {
            const m = raw.match(/agentId:\s*([^\s)]+)/);
            if (m?.[1]) spawn.agentId = m[1];
          }

          out.blocks.push({
            kind: "tool_result",
            text: raw,
            tool: spawn?.tool || "unknown",
            ...(b.tool_use_id ? { toolUseId: b.tool_use_id } : {}),
            status: rejected ? "rejected" : b.is_error === true ? "error" : "ok",
            outChars: resultSize(b, obj.toolUseResult),
          } as NeutralBlock & { outChars: number });
          break;
        }
      }
    }
  }

  const branch =
    Object.entries(branchCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || "unknown";

  // The band starts in `default`: Claude Code only stamps `permissionMode` once
  // it is set, so anything before the first transition ran in the default mode.
  if (!modeTransitions.length || modeTransitions[0]!.t > 0) {
    modeTransitions.unshift({ t: 0, mode: "default" });
  }

  return {
    uuid,
    sessionId: sessionId || uuid,
    cwd,
    version,
    branch,
    source: "claude-code",
    firstTimestamp,
    lastTimestamp,
    messages,
    modeTransitions,
  };
}

// Newest mtime anywhere under a directory tree.
function newestMtimeUnder(dir: string): number {
  let newest = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    newest = entry.isDirectory()
      ? Math.max(newest, newestMtimeUnder(full))
      : Math.max(newest, fs.statSync(full).mtimeMs);
  }
  return newest;
}

// Build a readable run-dir name: <runTs>-<workflowName>-<runId>. Name and
// timestamp come from the sibling <session>/workflows/<runId>.json; falls back
// to the script filename, then to the bare runId.
function resolveWorkflowRunLabel(
  wfMetaDir: string,
  runId: string,
  formatTimestamp: (iso: string) => string,
): string {
  let name = "";
  let runTs = "";

  const metaFile = path.join(wfMetaDir, `${runId}.json`);
  if (fs.existsSync(metaFile)) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaFile, "utf-8"));
      if (typeof meta.workflowName === "string") name = meta.workflowName;
      if (typeof meta.timestamp === "string") runTs = formatTimestamp(meta.timestamp);
    } catch {
      /* ignore malformed metadata */
    }
  }

  if (!name) {
    const scriptsDir = path.join(wfMetaDir, "scripts");
    if (fs.existsSync(scriptsDir)) {
      const script = fs.readdirSync(scriptsDir).find((f) => f.endsWith(`-${runId}.js`));
      if (script) name = script.replace(`-${runId}.js`, "");
    }
  }

  return [runTs, name, runId].filter(Boolean).join("-");
}

// Read agent/skill configuration under a `.claude` dir, for the setup panel.
export function readSetupDir(dir: string): SetupItem[] {
  const items: SetupItem[] = [];
  if (!fs.existsSync(dir)) return items;

  const agentsDir = path.join(dir, "agents");
  if (fs.existsSync(agentsDir)) {
    for (const f of fs.readdirSync(agentsDir).filter((f) => f.endsWith(".md")).sort()) {
      const fm = frontmatter(path.join(agentsDir, f));
      items.push({
        kind: "agent",
        name: fm.name || f.replace(/\.md$/, ""),
        description: fm.description || "",
      });
    }
  }

  const skillsDir = path.join(dir, "skills");
  if (fs.existsSync(skillsDir)) {
    for (const entry of fs
      .readdirSync(skillsDir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const skillFile = entry.isDirectory()
        ? path.join(skillsDir, entry.name, "SKILL.md")
        : entry.name.endsWith(".md")
          ? path.join(skillsDir, entry.name)
          : "";
      if (!skillFile || !fs.existsSync(skillFile)) continue;
      const fm = frontmatter(skillFile);
      items.push({
        kind: "skill",
        name: fm.name || entry.name.replace(/\.md$/, ""),
        description: fm.description || "",
      });
    }
  }

  return items;
}

export function frontmatter(file: string): { name?: string; description?: string } {
  try {
    const text = fs.readFileSync(file, "utf-8");
    const m = text.match(/^---\n([\s\S]*?)\n---/);
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

export interface ClaudeAdapterOptions {
  projectRoot: string;
  // Exact transcript-folder name under `<claudeDir>/projects`, overriding the
  // one derived from `projectRoot`. Used for Conductor workspaces matched by
  // folder name: an archived workspace's directory is gone — there is no root
  // path to derive from — but its transcripts remain. `projectRoot` then only
  // serves `setup()`.
  projectDirName?: string;
  claudeDir?: string;
  // Injected so filename timestamps stay formatted in one place.
  formatTimestamp: (iso: string) => string;
}

export function resolveClaudeDir(claudeDir?: string): string {
  return claudeDir
    ? path.resolve(claudeDir.replace(/^~(?=$|\/)/, os.homedir()))
    : path.join(os.homedir(), ".claude");
}

// Transcript folders recorded for Conductor workspaces of the named repo.
// Matched on the sanitized folder *name* — any folder for a path containing
// `conductor/workspaces/<repo>/` — rather than on directories that still exist,
// because archiving a workspace deletes its directory (and its git worktree
// registration) while the transcripts stay behind. The sanitization is lossy
// (`/`, `_`, `.` all become `-`), so a repo whose name prefixes another's could
// over-match; workspace names are single words, which keeps that theoretical.
export function conductorProjectDirNames(claudeDir: string, repoName: string): string[] {
  const projectsDir = path.join(claudeDir, "projects");
  if (!fs.existsSync(projectsDir)) return [];
  const marker = `-conductor-workspaces-${repoName.replace(/[/_.]/g, "-")}-`;
  return fs.readdirSync(projectsDir).filter((name) => name.includes(marker)).sort();
}

export class ClaudeAdapter implements SourceAdapter {
  readonly source = "claude-code" as const;
  readonly origin: string;
  private readonly projectPath: string;
  private readonly opts: ClaudeAdapterOptions;
  private readonly claudeDir: string;

  constructor(opts: ClaudeAdapterOptions) {
    this.opts = opts;
    this.claudeDir = resolveClaudeDir(opts.claudeDir);
    this.projectPath = path.join(
      this.claudeDir,
      "projects",
      opts.projectDirName ?? opts.projectRoot.replace(/[/_.]/g, "-"),
    );
    this.origin = this.projectPath;
  }

  list(): SourceSessionRef[] {
    if (!fs.existsSync(this.projectPath)) return [];
    return fs
      .readdirSync(this.projectPath)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => {
        const uuid = f.replace(".jsonl", "");
        return { uuid, prefix: uuid.split("-")[0] ?? uuid, mtime: this.mtimeOf(uuid) };
      });
  }

  // Newest mtime across a session's whole source tree — the main jsonl plus
  // everything under <uuid>/subagents/, where workflow and subagent transcripts
  // keep growing while the main conversation's timestamp stays frozen.
  private mtimeOf(uuid: string): number {
    let newest = 0;
    const main = path.join(this.projectPath, `${uuid}.jsonl`);
    if (fs.existsSync(main)) newest = fs.statSync(main).mtimeMs;
    const subDir = path.join(this.projectPath, uuid, "subagents");
    if (fs.existsSync(subDir)) newest = Math.max(newest, newestMtimeUnder(subDir));
    return newest;
  }

  load(ref: SourceSessionRef): NeutralConversation {
    const lines = readLines(path.join(this.projectPath, `${ref.uuid}.jsonl`));
    const session = parseJsonl(lines, ref.uuid);

    const subagents: NeutralTranscript[] = [];
    const workflows: NeutralTranscript[] = [];
    const subagentsDir = path.join(this.projectPath, ref.uuid, "subagents");

    if (fs.existsSync(subagentsDir)) {
      for (const f of fs.readdirSync(subagentsDir).filter((f) => f.endsWith(".jsonl"))) {
        const id = f.replace("agent-", "").replace(".jsonl", "");
        try {
          subagents.push({
            id,
            session: parseJsonl(readLines(path.join(subagentsDir, f)), id),
          });
        } catch (e) {
          console.error(`    Agent error (${id}): ${e}`);
        }
      }

      // Workflow agents live one level deeper, grouped per run.
      const workflowsDir = path.join(subagentsDir, "workflows");
      const wfMetaDir = path.join(this.projectPath, ref.uuid, "workflows");
      if (fs.existsSync(workflowsDir)) {
        for (const d of fs.readdirSync(workflowsDir, { withFileTypes: true })) {
          if (!d.isDirectory()) continue;
          const wfDir = path.join(workflowsDir, d.name);
          const files = fs
            .readdirSync(wfDir)
            .filter((f) => f.startsWith("agent-") && f.endsWith(".jsonl"));
          if (!files.length) continue;
          const group = resolveWorkflowRunLabel(wfMetaDir, d.name, this.opts.formatTimestamp);
          for (const f of files) {
            const id = f.replace("agent-", "").replace(".jsonl", "");
            try {
              workflows.push({
                id,
                group,
                session: parseJsonl(readLines(path.join(wfDir, f)), id),
              });
            } catch (e) {
              console.error(`    Workflow agent error (${d.name}/${id}): ${e}`);
            }
          }
        }
      }
    }

    return { session, subagents, workflows };
  }

  setup(): { project: SetupItem[]; user: SetupItem[] } {
    return {
      project: readSetupDir(path.join(this.opts.projectRoot, ".claude")),
      user: readSetupDir(this.claudeDir),
    };
  }
}
