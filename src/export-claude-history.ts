#!/usr/bin/env tsx
// export-claude-history v1.7

import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

function getProjectRoot(): string {
  try {
    return execSync("git rev-parse --show-toplevel", { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch {
    return process.cwd();
  }
}

const projectRoot = getProjectRoot();

// Parse CLI: positional args, `--full`, and `--claude-dir <path>` (also
// accepts `--claude-dir=<path>`) to override the default `~/.claude` location.
const rawArgs = process.argv.slice(2);
const fullExport = rawArgs.includes("--full");
const positional: string[] = [];
let claudeDirArg: string | undefined;
for (let i = 0; i < rawArgs.length; i++) {
  const a = rawArgs[i];
  if (a === undefined) continue;
  if (a === "--full") continue;
  if (a === "--claude-dir") {
    claudeDirArg = rawArgs[++i];
    continue;
  }
  if (a.startsWith("--claude-dir=")) {
    claudeDirArg = a.slice("--claude-dir=".length);
    continue;
  }
  if (a.startsWith("--")) continue;
  positional.push(a);
}

const claudeDir = claudeDirArg
  ? path.resolve(claudeDirArg.replace(/^~(?=$|\/)/, os.homedir()))
  : path.join(os.homedir(), ".claude");
const claudeProjectPath = path.join(claudeDir, "projects", projectRoot.replace(/\//g, "-"));
const targetDirArg = positional[0];

if (!targetDirArg) {
  console.error("Usage: export-claude-history <target-dir> [--full] [--claude-dir <path>]");
  process.exit(1);
}

const targetDir = path.isAbsolute(targetDirArg)
  ? targetDirArg
  : path.join(projectRoot, targetDirArg);

// --- Types ---

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

interface RawUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

// --- Sidecar (dashboard data) types ---

// Token usage, normalized to short keys so the sidecar stays compact.
interface Usage {
  in: number;
  out: number;
  cw: number; // cache creation (write)
  cr: number; // cache read
}

// A single event on the message timeline. `t` is seconds from session start.
interface TimelinePoint {
  i: number;
  kind:
    | "prompt"
    | "assistant"
    | "thinking"
    | "tool_use"
    | "tool_result"
    | "notification"
    | "skill";
  t: number;
  model?: string;
  tool?: string;
  label?: string; // short text preview (prompts, tool inputs)
  permissionMode?: string;
  usage?: Usage; // present on assistant API calls only
}

interface SubagentSpawn {
  type: string;
  description: string;
  input: string;
  t: number;
}

interface DiffLine {
  type: "add" | "del" | "ctx";
  text: string;
}

interface DiffEntry {
  op: "Write" | "Edit";
  filePath: string;
  added: number;
  removed: number;
  hunk: DiffLine[];
}

interface PermissionSegment {
  mode: string;
  start: number; // seconds
  end: number; // seconds
}

interface SetupItem {
  kind: "agent" | "skill";
  name: string;
  description: string;
}

interface Sidecar {
  uuid: string;
  sessionId: string;
  cwd: string;
  branch: string;
  version: string;
  title: string;
  start: string;
  end: string;
  durationSeconds: number;
  timeZone: string;
  stats: {
    humanTurns: number;
    linesAdded: number;
    linesRemoved: number;
    toolCounts: { read: number; search: number; bash: number; edit: number; other: number };
  };
  timeline: TimelinePoint[];
  permissionSegments: PermissionSegment[];
  subagents: SubagentSpawn[];
  // Aggregated token usage across every subagent/workflow transcript, by model.
  subagentUsageByModel: Record<string, Usage>;
  diffs: DiffEntry[];
  setup: {
    project: SetupItem[];
    user: SetupItem[];
  };
}

// --- Helpers ---

const SKIP_TYPES = new Set([
  "progress",
  "system",
  "queue-operation",
  "file-history-snapshot",
]);

const LANG_MAP: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  py: "python",
  rb: "ruby",
  sh: "bash",
  yml: "yaml",
  yaml: "yaml",
  json: "json",
  md: "markdown",
  css: "css",
  html: "html",
  sql: "sql",
  php: "php",
};

function langFor(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() || "";
  return LANG_MAP[ext] || ext;
}

function formatToolInput(name: string, input: unknown): string {
  const obj = typeof input === "object" && input !== null ? input : null;
  if (!obj) return JSON.stringify(input);

  const { file_path, content, old_string, new_string, command, description, pattern } =
    obj as Record<string, string | undefined>;

  switch (name) {
    case "Write": {
      const lang = langFor(file_path || "");
      const body = truncate(content || "");
      if (lang === "markdown") {
        return `\`${file_path}\`\n\n    ${body.split("\n").join("\n    ")}`;
      }
      return `\`${file_path}\`\n\`\`\`${lang}\n${body}\n\`\`\``;
    }
    case "Edit":
      return `\`${file_path}\`\n\`\`\`diff\n- ${truncate(old_string || "").split("\n").join("\n- ")}\n+ ${truncate(new_string || "").split("\n").join("\n+ ")}\n\`\`\``;
    case "Bash":
      return `${description ? description + "\n" : ""}\`\`\`bash\n${command}\n\`\`\``;
    case "Read": {
      const { offset, limit } = obj as Record<string, number | undefined>;
      const range = offset || limit ? ` (${offset ? `offset:${offset}` : ""}${offset && limit ? " " : ""}${limit ? `limit:${limit}` : ""})` : "";
      return `\`${file_path}\`${range}`;
    }
    case "Glob":
      return `\`${pattern}\``;
    case "Grep": {
      const { path: grepPath } = obj as Record<string, string | undefined>;
      return grepPath ? `\`${pattern}\` in \`${grepPath}\`` : `\`${pattern}\``;
    }
    case "Agent": {
      const { prompt, ...rest } = obj as Record<string, unknown>;
      const fields = Object.entries(rest)
        .filter(([, v]) => v !== undefined && v !== null)
        .map(([k, v]) => `${k}: ${v}`)
        .join(", ");
      const promptBlock = prompt
        ? `\n\n    ${String(prompt).split("\n").join("\n    ")}\n\n`
        : "";
      return fields + promptBlock;
    }
    default: {
      return truncate(JSON.stringify(input), 500);
    }
  }
}

function extractXmlTag(xml: string, tag: string): string {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`);
  const m = xml.match(re);
  return m?.[1]?.trim() ?? "";
}

function formatCommandMessage(raw: string): string {
  const name = extractXmlTag(raw, "command-name");
  const args = extractXmlTag(raw, "command-args");
  return args ? `\`${name}\` ${args}` : name ? `\`${name}\`` : raw;
}

function formatTaskNotification(raw: string): string {
  const summary = extractXmlTag(raw, "summary");
  const result = extractXmlTag(raw, "result");
  const parts: string[] = [];
  if (summary) parts.push(summary);
  if (result) parts.push(result);
  return parts.join("\n\n") || raw;
}

function truncate(s: string, max = 2000): string {
  if (fullExport || s.length <= max) return s;
  const kept = s.slice(0, max);
  const truncatedLines = s.slice(max).split("\n").length;
  return kept + `\n...(${truncatedLines} lines truncated)`;
}

function readLines(filePath: string): string[] {
  return fs
    .readFileSync(filePath, "utf-8")
    .split("\n")
    .filter((l) => l.trim());
}

// UTC ISO (…Z) → local-time YYYY-MM-DD-HH-MM-SS (for filenames)
function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso.replace("T", "-").replace(/:/g, "-").replace(/\.\d+Z$/, "");
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-` +
    `${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`
  );
}

// UTC ISO (…Z) → readable local time "YYYY-MM-DD HH:MM:SS ±HHMM" (for headers)
function formatLocal(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, "0");
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const oh = p(Math.floor(Math.abs(off) / 60));
  const om = p(Math.abs(off) % 60);
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} ${sign}${oh}${om}`
  );
}

function formatDuration(startIso: string, endIso: string): string {
  const mins = Math.round(
    (new Date(endIso).getTime() - new Date(startIso).getTime()) / 60000,
  );
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h${mins % 60}m`;
}

function sanitizeBranch(branch: string): string {
  return branch.replace(/[^a-zA-Z0-9-_]/g, "-").replace(/-+/g, "-");
}

function getGitUsername(): string {
  try {
    return execSync("git config user.email", { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim().split("@")[0] || os.userInfo().username;
  } catch {
    return os.userInfo().username;
  }
}

// --- Parsing ---

function getLastTimestamp(lines: string[]): string {
  let last = "";
  for (const line of lines) {
    const m = line.match(/"timestamp":"([^"]+)"/);
    if (m) last = m[1] ?? "";
  }
  return last;
}

// Build a readable run-dir name: <runTs>-<workflowName>-<runId>.
// name + timestamp come from the sibling <session>/workflows/<runId>.json;
// falls back to the script filename, then to the bare runId.
function resolveWorkflowRunLabel(wfMetaDir: string, runId: string): string {
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

  // Fallback: derive name from workflows/scripts/<name>-<runId>.js
  if (!name) {
    const scriptsDir = path.join(wfMetaDir, "scripts");
    if (fs.existsSync(scriptsDir)) {
      const script = fs
        .readdirSync(scriptsDir)
        .find((f) => f.endsWith(`-${runId}.js`));
      if (script) name = script.replace(`-${runId}.js`, "");
    }
  }

  const parts = [runTs, name, runId].filter(Boolean);
  return parts.join("-");
}

function parseConversation(lines: string[], uuid: string) {
  const messages: string[] = [];
  let firstTimestamp = "";
  let lastTimestamp = "";
  const branchCounts: Record<string, number> = {};
  const categories: Record<string, number> = {};
  const pendingTools = new Map<string, { name: string; input: unknown }>();

  const count = (key: string) => {
    categories[key] = (categories[key] || 0) + 1;
  };

  for (const line of lines) {
    let obj: JsonlLine;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

    if (obj.timestamp) {
      if (!firstTimestamp) firstTimestamp = obj.timestamp;
      lastTimestamp = obj.timestamp;
    }
    if (obj.gitBranch) {
      branchCounts[obj.gitBranch] = (branchCounts[obj.gitBranch] || 0) + 1;
    }
    if (SKIP_TYPES.has(obj.type || "")) continue;

    const msg = obj.message;
    if (!msg?.role) continue;

    // String content = user message or task notification
    if (typeof msg.content === "string") {
      if (msg.content.trim()) {
        if (msg.content.trimStart().startsWith("<task-notification>")) {
          count("task_notification");
          messages.push(`\n## 🔔 Task Notification\n${formatTaskNotification(msg.content)}`);
        } else if (msg.content.trimStart().startsWith("<command-message>")) {
          count("skill_call");
          messages.push(`\n## 🧑 User calling skill\n${formatCommandMessage(msg.content)}`);
        } else if (msg.content.trimStart().startsWith("Base directory for this skill:")) {
          count("skill_prompt");
          messages.push(`\n## 📜 Skill Prompt\n${msg.content}`);
        } else {
          count("user");
          messages.push(`\n## 🧑 User\n${msg.content}`);
        }
      }
      continue;
    }

    if (!Array.isArray(msg.content)) continue;

    for (const b of msg.content) {
      switch (b.type) {
        case "thinking":
          if (b.thinking) {
            count("thinking");
            messages.push(`\n## 🧠 Thinking\n${b.thinking}`);
          }
          break;

        case "text":
          if (b.text?.trim()) {
            if (msg.role === "assistant") {
              count("assistant");
              messages.push(`\n## 🤖 Assistant\n${b.text}`);
            } else if (b.text.trimStart().startsWith("Base directory for this skill:")) {
              count("skill_prompt");
              messages.push(`\n## 📜 Skill Prompt\n${b.text}`);
            } else {
              count("user");
              messages.push(`\n## 🧑 User\n${b.text}`);
            }
          }
          break;

        case "tool_use":
          count(`tool_call:${b.name}`);
          if (b.id) pendingTools.set(b.id, { name: b.name!, input: b.input });
          messages.push(
            `\n## ⚪️ Tool Call: ${b.name}\n${formatToolInput(b.name!, b.input)}`,
          );
          break;

        case "tool_result": {
          const pending = b.tool_use_id ? pendingTools.get(b.tool_use_id) : null;
          if (b.tool_use_id) pendingTools.delete(b.tool_use_id);

          const toolName = pending?.name || "unknown";
          const isRejected = obj.toolUseResult === "User rejected tool use";
          const isError = b.is_error === true && !isRejected;

          const raw =
            typeof b.content === "string"
              ? b.content
              : Array.isArray(b.content)
                ? b.content.map((c: { text?: string }) => c.text || "").join("\n")
                : "";
          const body = toolName === "Grep" || toolName === "Read" || toolName === "Bash"
            ? "    " + truncate(raw).split("\n").join("\n    ")
            : truncate(raw);

          if (isRejected) {
            count("tool_rejected");
            messages.push(`\n## ❌ Tool Rejected: ${toolName}\n${body}`);
          } else if (isError) {
            count("tool_error");
            messages.push(`\n## 🔴 Tool Error: ${toolName}\n${body}`);
          } else if (body.trim()) {
            count("tool_result");
            messages.push(`\n## 🟢 Tool Result: ${toolName}\n${body}`);
          }
          break;
        }
      }
    }
  }

  const branch =
    Object.entries(branchCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || "unknown";

  return { messages, firstTimestamp, lastTimestamp, branch, categories, uuid };
}

// --- Formatting ---

const MSG_DEFS = [
  { key: "user", emoji: "🧑", label: "User" },
  { key: "skill_call", emoji: "🧑", label: "Skill Call" },
  { key: "skill_prompt", emoji: "📜", label: "Skill Prompt" },
  { key: "assistant", emoji: "🤖", label: "Assistant" },
  { key: "thinking", emoji: "🧠", label: "Thinking" },
  { key: "tool_result", emoji: "🟢", label: "Tool Result" },
  { key: "task_notification", emoji: "🔔", label: "Task Notification" },
  { key: "tool_error", emoji: "🔴", label: "Tool Error" },
  { key: "tool_rejected", emoji: "❌", label: "Tool Rejected" },
];

function formatHeader(stats: ReturnType<typeof parseConversation>): string {
  const msgLine = MSG_DEFS.filter((d) => stats.categories[d.key])
    .map((d) => `${stats.categories[d.key]} ${d.emoji} ${d.label}`)
    .join(", ");

  const toolLine = Object.entries(stats.categories)
    .filter(([k]) => k.startsWith("tool_call:"))
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${v} ${k.replace("tool_call:", "")}`)
    .join(", ");

  return `---
uuid: ${stats.uuid}
branch: ${stats.branch}
started: ${formatLocal(stats.firstTimestamp)}
ended: ${formatLocal(stats.lastTimestamp)}
duration: ${formatDuration(stats.firstTimestamp, stats.lastTimestamp)}
messages: ${msgLine}
tools: ${toolLine || "none"}
---
`;
}

// --- Export logic ---

// Map each source uuid to every already-exported session .md for it. Normally
// one, but stale duplicates can pile up as the session timestamp advances — we
// track them all so a re-export can clear the lot.
function findExistingExports(): Map<string, string[]> {
  const exported = new Map<string, string[]>();
  if (!fs.existsSync(targetDir)) return exported;

  // Build prefix → uuid[] from source files
  const prefixToUuids = new Map<string, string[]>();
  for (const f of fs.readdirSync(claudeProjectPath).filter((f) => f.endsWith(".jsonl"))) {
    const uuid = f.replace(".jsonl", "");
    const prefix = uuid.split("-")[0] ?? "";
    if (!prefixToUuids.has(prefix)) prefixToUuids.set(prefix, []);
    prefixToUuids.get(prefix)!.push(uuid);
  }

  // Scan target dir for existing session exports. The `{8}` prefix match only
  // catches session files (`<ts>-<prefix>.md`); agent files use 17-char ids.
  function scan(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        scan(full);
        continue;
      }
      const m = entry.name.match(
        /^(\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2})-([a-f0-9]{8})\.(md|txt)$/,
      );
      if (!m) continue;
      for (const uuid of prefixToUuids.get(m[2] ?? "") || []) {
        if (!exported.has(uuid)) exported.set(uuid, []);
        exported.get(uuid)!.push(full);
      }
    }
  }

  scan(targetDir);
  return exported;
}

// Newest mtime across the whole source tree of a session: the main <uuid>.jsonl
// plus everything under <uuid>/subagents/ (where workflow/subagent transcripts
// grow while the main conversation timestamp stays frozen).
function newestMtimeUnder(dir: string): number {
  let newest = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestMtimeUnder(full));
    } else {
      newest = Math.max(newest, fs.statSync(full).mtimeMs);
    }
  }
  return newest;
}

function sourceMtime(uuid: string): number {
  let newest = 0;
  const main = path.join(claudeProjectPath, `${uuid}.jsonl`);
  if (fs.existsSync(main)) newest = fs.statSync(main).mtimeMs;
  const subDir = path.join(claudeProjectPath, uuid, "subagents");
  if (fs.existsSync(subDir)) newest = Math.max(newest, newestMtimeUnder(subDir));
  return newest;
}

// Remove a prior export (session .md + its -subagents / -workflows sidecar dirs)
// so a re-export at a new timestamp replaces rather than duplicates it.
function removeExportOutputs(sessionMdPath: string): void {
  const dir = path.dirname(sessionMdPath);
  const base = path.basename(sessionMdPath).replace(/\.(md|txt)$/, "");
  fs.rmSync(sessionMdPath, { force: true });
  fs.rmSync(path.join(dir, `${base}.json`), { force: true });
  fs.rmSync(path.join(dir, `${base}-subagents`), { recursive: true, force: true });
  fs.rmSync(path.join(dir, `${base}-workflows`), { recursive: true, force: true });
}

function loadSkippedUuids(): Set<string> {
  const file = path.join(targetDir, ".skipped");
  if (!fs.existsSync(file)) return new Set();
  return new Set(fs.readFileSync(file, "utf-8").split("\n").filter((l) => l.trim()));
}

function saveSkippedUuid(uuid: string): void {
  const file = path.join(targetDir, ".skipped");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, uuid + "\n");
}

function exportFile(lines: string[], id: string, targetFile: string): boolean {
  const stats = parseConversation(lines, id);
  if (!stats.messages.join("").trim()) return false;
  fs.mkdirSync(path.dirname(targetFile), { recursive: true });
  fs.writeFileSync(targetFile, formatHeader(stats) + stats.messages.join("\n"));
  return true;
}

// --- Sidecar (dashboard data) extraction ---

function emptyUsage(): Usage {
  return { in: 0, out: 0, cw: 0, cr: 0 };
}

function normUsage(u: RawUsage | undefined): Usage {
  return {
    in: u?.input_tokens ?? 0,
    out: u?.output_tokens ?? 0,
    cw: u?.cache_creation_input_tokens ?? 0,
    cr: u?.cache_read_input_tokens ?? 0,
  };
}

function addUsage(acc: Usage, u: Usage): void {
  acc.in += u.in;
  acc.out += u.out;
  acc.cw += u.cw;
  acc.cr += u.cr;
}

// Sum token usage by model across an arbitrary transcript (used for subagents).
function sumUsageByModel(lines: string[], acc: Record<string, Usage>): void {
  for (const line of lines) {
    let obj: JsonlLine;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const model = obj.message?.model;
    const usage = obj.message?.usage;
    if (obj.type === "assistant" && model && usage) {
      if (!acc[model]) acc[model] = emptyUsage();
      addUsage(acc[model]!, normUsage(usage));
    }
  }
}

function splitLines(s: string): string[] {
  return s.replace(/\n$/, "").split("\n");
}

// Walk a session's subagent + workflow transcripts, summing token usage by model.
function accumulateSubagentUsage(uuid: string, acc: Record<string, Usage>): void {
  const subagentsDir = path.join(claudeProjectPath, uuid, "subagents");
  if (!fs.existsSync(subagentsDir)) return;

  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith(".jsonl")) {
        try {
          sumUsageByModel(readLines(full), acc);
        } catch {
          /* skip unreadable transcript */
        }
      }
    }
  };
  walk(subagentsDir);
}

const TOOL_BUCKETS: Record<string, keyof Sidecar["stats"]["toolCounts"]> = {
  Read: "read",
  Glob: "search",
  Grep: "search",
  Bash: "bash",
  Edit: "edit",
  MultiEdit: "edit",
  Write: "edit",
};

// Read Claude agent/skill configuration under a `.claude` dir, for the setup panel.
function readSetupDir(claudeDir: string): SetupItem[] {
  const items: SetupItem[] = [];
  if (!fs.existsSync(claudeDir)) return items;

  const frontmatter = (file: string): { name?: string; description?: string } => {
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
  };

  const agentsDir = path.join(claudeDir, "agents");
  if (fs.existsSync(agentsDir)) {
    for (const f of fs.readdirSync(agentsDir).filter((f) => f.endsWith(".md")).sort()) {
      const fm = frontmatter(path.join(agentsDir, f));
      items.push({ kind: "agent", name: fm.name || f.replace(/\.md$/, ""), description: fm.description || "" });
    }
  }

  const skillsDir = path.join(claudeDir, "skills");
  if (fs.existsSync(skillsDir)) {
    for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const skillFile = entry.isDirectory()
        ? path.join(skillsDir, entry.name, "SKILL.md")
        : entry.name.endsWith(".md")
          ? path.join(skillsDir, entry.name)
          : "";
      if (!skillFile || !fs.existsSync(skillFile)) continue;
      const fm = frontmatter(skillFile);
      items.push({ kind: "skill", name: fm.name || entry.name.replace(/\.md$/, ""), description: fm.description || "" });
    }
  }

  return items;
}

// Map a Claude Code permission-mode value to a short human label + icon.
const MODE_LABELS: Record<string, string> = {
  default: "⌨️ Normal",
  acceptEdits: "⚡ Auto-accept",
  plan: "📝 Plan",
  bypassPermissions: "⏭️ Bypass",
};

// Single pass over the main transcript to produce the dashboard sidecar
// (minus subagent usage + setup, which the caller fills in).
function buildSidecar(lines: string[], uuid: string): Sidecar {
  const timeline: TimelinePoint[] = [];
  const subagents: SubagentSpawn[] = [];
  const diffs: DiffEntry[] = [];
  const toolCounts = { read: 0, search: 0, bash: 0, edit: 0, other: 0 };
  const modeTransitions: Array<{ t: number; mode: string }> = [];

  let firstTs = "";
  let lastTs = "";
  let cwd = "";
  let version = "";
  let sessionId = "";
  let branch = "";
  let title = "";
  let humanTurns = 0;
  const branchCounts: Record<string, number> = {};
  const pendingTools = new Map<string, string>();

  const toSec = (ts: string): number =>
    firstTs ? (new Date(ts).getTime() - new Date(firstTs).getTime()) / 1000 : 0;

  let i = 0;
  for (const line of lines) {
    let obj: JsonlLine;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

    if (obj.timestamp) {
      if (!firstTs) firstTs = obj.timestamp;
      lastTs = obj.timestamp;
    }
    if (obj.cwd) cwd = obj.cwd;
    if (obj.version) version = obj.version;
    if (obj.sessionId) sessionId = obj.sessionId;
    if (obj.gitBranch) branchCounts[obj.gitBranch] = (branchCounts[obj.gitBranch] || 0) + 1;
    if (obj.permissionMode && obj.timestamp) {
      const t = toSec(obj.timestamp);
      const prev = modeTransitions[modeTransitions.length - 1];
      if (!prev || prev.mode !== obj.permissionMode) modeTransitions.push({ t, mode: obj.permissionMode });
    }

    if (SKIP_TYPES.has(obj.type || "")) continue;
    const msg = obj.message;
    if (!msg?.role) continue;
    const t = obj.timestamp ? toSec(obj.timestamp) : 0;

    if (typeof msg.content === "string") {
      const c = msg.content.trim();
      if (!c) continue;
      if (c.startsWith("<task-notification>")) {
        timeline.push({ i: i++, kind: "notification", t });
      } else if (
        c.startsWith("<command-message>") ||
        c.startsWith("<command-name>") ||
        c.startsWith("<local-command-caveat>") ||
        c.startsWith("Base directory for this skill:")
      ) {
        // Local-command noise (/clear, /compact, skill invocations) — not a human turn.
        timeline.push({ i: i++, kind: "skill", t });
      } else {
        humanTurns++;
        if (!title) title = c;
        timeline.push({ i: i++, kind: "prompt", t, label: truncate(c, 400) });
      }
      continue;
    }
    if (!Array.isArray(msg.content)) continue;

    const model = msg.model;
    const pm = obj.permissionMode;
    let usageAttached = false;

    for (const b of msg.content) {
      switch (b.type) {
        case "thinking":
          if (b.thinking) timeline.push({ i: i++, kind: "thinking", t, ...(model ? { model } : {}) });
          break;
        case "text":
          if (b.text?.trim()) {
            if (msg.role === "assistant") {
              const point: TimelinePoint = { i: i++, kind: "assistant", t };
              if (model) point.model = model;
              if (pm) point.permissionMode = pm;
              if (!usageAttached && msg.usage) {
                point.usage = normUsage(msg.usage);
                usageAttached = true;
              }
              timeline.push(point);
            } else if (b.text.trimStart().startsWith("Base directory for this skill:")) {
              timeline.push({ i: i++, kind: "skill", t });
            } else {
              humanTurns++;
              const txt = b.text.trim();
              if (!title) title = txt;
              timeline.push({ i: i++, kind: "prompt", t, label: truncate(txt, 400) });
            }
          }
          break;
        case "tool_use": {
          const name = b.name || "";
          if (b.id) pendingTools.set(b.id, name);
          toolCounts[TOOL_BUCKETS[name] ?? "other"]++;
          const point: TimelinePoint = { i: i++, kind: "tool_use", t, tool: name };
          if (model) point.model = model;
          if (!usageAttached && msg.usage) {
            point.usage = normUsage(msg.usage);
            usageAttached = true;
          }
          timeline.push(point);

          if ((name === "Agent" || name === "Task") && b.input && typeof b.input === "object") {
            const inp = b.input as Record<string, unknown>;
            subagents.push({
              type: String(inp["subagent_type"] ?? inp["agentType"] ?? "agent"),
              description: String(inp["description"] ?? ""),
              input: truncate(String(inp["prompt"] ?? ""), 600),
              t,
            });
          }
          if (name === "Write" || name === "Edit") {
            const d = diffFromToolUse(name, b.input);
            if (d) diffs.push(d);
          }
          break;
        }
        case "tool_result":
          if (b.tool_use_id) pendingTools.delete(b.tool_use_id);
          timeline.push({ i: i++, kind: "tool_result", t });
          break;
      }
    }
  }

  branch = Object.entries(branchCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || "unknown";
  const durationSeconds = firstTs && lastTs ? (new Date(lastTs).getTime() - new Date(firstTs).getTime()) / 1000 : 0;

  // Build permission-mode segments spanning [start, end]. Assume `default`
  // until the first observed transition.
  const permissionSegments: PermissionSegment[] = [];
  const transitions = modeTransitions.length && modeTransitions[0]!.t > 0
    ? [{ t: 0, mode: "default" }, ...modeTransitions]
    : modeTransitions.length
      ? modeTransitions
      : [{ t: 0, mode: "default" }];
  for (let k = 0; k < transitions.length; k++) {
    permissionSegments.push({
      mode: transitions[k]!.mode,
      start: transitions[k]!.t,
      end: k + 1 < transitions.length ? transitions[k + 1]!.t : durationSeconds,
    });
  }

  const linesAdded = diffs.reduce((s, d) => s + d.added, 0);
  const linesRemoved = diffs.reduce((s, d) => s + d.removed, 0);

  let timeZone = "UTC";
  try {
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    /* keep UTC */
  }

  return {
    uuid,
    sessionId: sessionId || uuid,
    cwd,
    branch,
    version,
    title,
    start: firstTs,
    end: lastTs,
    durationSeconds,
    timeZone,
    stats: { humanTurns, linesAdded, linesRemoved, toolCounts },
    timeline,
    permissionSegments,
    subagents,
    subagentUsageByModel: {},
    diffs,
    setup: { project: [], user: [] },
  };
}

// Turn a Write/Edit tool_use into a diff entry with a small preview hunk.
function diffFromToolUse(name: string, input: unknown): DiffEntry | null {
  if (typeof input !== "object" || input === null) return null;
  const obj = input as Record<string, string | undefined>;
  const filePath = obj["file_path"];
  if (!filePath) return null;

  if (name === "Write") {
    const content = obj["content"] || "";
    const lines = content ? splitLines(content) : [];
    return {
      op: "Write",
      filePath,
      added: lines.length,
      removed: 0,
      hunk: lines.slice(0, 40).map((text) => ({ type: "add" as const, text })),
    };
  }
  // Edit
  const oldLines = obj["old_string"] ? splitLines(obj["old_string"]) : [];
  const newLines = obj["new_string"] ? splitLines(obj["new_string"]) : [];
  const hunk: DiffLine[] = [
    ...oldLines.slice(0, 30).map((text) => ({ type: "del" as const, text })),
    ...newLines.slice(0, 30).map((text) => ({ type: "add" as const, text })),
  ];
  return { op: "Edit", filePath, added: newLines.length, removed: oldLines.length, hunk };
}

// --- Main ---

function main() {
  console.log(`Export Claude History → ${targetDir}\n`);

  if (!fs.existsSync(claudeProjectPath)) {
    console.error(`Error: Claude project path not found: ${claudeProjectPath}`);
    process.exit(1);
  }

  const allFiles = fs.readdirSync(claudeProjectPath).filter((f) => f.endsWith(".jsonl"));
  const exported = findExistingExports();
  const skipped = loadSkippedUuids();

  // Find conversations needing export. A session is re-exported when its source
  // tree (main jsonl + subagents/workflows transcripts) is newer than the
  // already-exported .md — so a running workflow's growing transcripts refresh
  // even though the main conversation timestamp is frozen.
  const toExport: Array<{ uuid: string; lines: string[]; priors: string[] }> = [];
  for (const file of allFiles) {
    const uuid = file.replace(".jsonl", "");
    if (skipped.has(uuid)) continue;

    const priors = exported.get(uuid) ?? [];
    // Up to date only when exactly one export exists and it is newer than the
    // source; more than one means stale duplicates to clean up.
    if (
      priors.length === 1 &&
      priors[0] !== undefined &&
      fs.existsSync(priors[0]) &&
      fs.statSync(priors[0]).mtimeMs >= sourceMtime(uuid)
    ) {
      continue;
    }

    const lines = readLines(path.join(claudeProjectPath, file));
    toExport.push({ uuid, lines, priors });
  }

  console.log(`Found ${allFiles.length} conversations, ${toExport.length} to export\n`);
  if (toExport.length === 0) return;

  const username = getGitUsername();

  for (const { uuid, lines, priors } of toExport) {
    const stats = parseConversation(lines, uuid);
    if (!stats.messages.join("").trim()) {
      saveSkippedUuid(uuid);
      continue;
    }

    // Replace all prior exports (old timestamps + sidecar dirs) so re-exports
    // don't accumulate stale duplicates as the session timestamp advances.
    for (const prior of priors) {
      if (fs.existsSync(prior)) removeExportOutputs(prior);
    }

    const prefix = uuid.split("-")[0];
    const ts = formatTimestamp(stats.lastTimestamp);
    const branchDir = path.join(targetDir, username, sanitizeBranch(stats.branch));
    const fileName = `${ts}-${prefix}.md`;

    fs.mkdirSync(branchDir, { recursive: true });
    const targetFile = path.join(branchDir, fileName);
    fs.writeFileSync(targetFile, formatHeader(stats) + stats.messages.join("\n"));
    // Print the absolute path so terminals render it as a clickable link.
    console.log(`  Exported: ${targetFile}`);

    // Sidecar JSON (structured metrics for the dashboard view). Sits next to the
    // .md so `cca-generate-html` can render both a -discussion and a -dashboard page.
    try {
      const sidecar = buildSidecar(lines, uuid);
      accumulateSubagentUsage(uuid, sidecar.subagentUsageByModel);
      sidecar.setup.project = readSetupDir(path.join(projectRoot, ".claude"));
      sidecar.setup.user = readSetupDir(claudeDir);
      fs.writeFileSync(targetFile.replace(/\.md$/, ".json"), JSON.stringify(sidecar));
    } catch (e) {
      console.error(`    Sidecar error: ${e}`);
    }

    // Export subagents
    const subagentsDir = path.join(claudeProjectPath, uuid, "subagents");
    if (!fs.existsSync(subagentsDir)) continue;

    const agentFiles = fs.readdirSync(subagentsDir).filter((f) => f.endsWith(".jsonl"));

    const subTargetDir = path.join(branchDir, `${ts}-${prefix}-subagents`);
    for (const agentFile of agentFiles) {
      const agentId = agentFile.replace("agent-", "").replace(".jsonl", "");
      try {
        const agentLines = readLines(path.join(subagentsDir, agentFile));
        const agentTs = formatTimestamp(getLastTimestamp(agentLines));
        exportFile(
          agentLines,
          agentId,
          path.join(subTargetDir, `${agentTs}-${agentId}.md`),
        );
      } catch (e) {
        console.error(`    Agent error (${agentId}): ${e}`);
      }
    }
    if (agentFiles.length > 0) {
      console.log(`    + ${agentFiles.length} subagent(s)`);
    }

    // Export workflow agents (nested under subagents/workflows/<wf_id>/agent-*.jsonl)
    const workflowsDir = path.join(subagentsDir, "workflows");
    if (!fs.existsSync(workflowsDir)) continue;

    const wfIds = fs
      .readdirSync(workflowsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);

    // Run metadata (name + timestamp) lives in a sibling dir: <session>/workflows/<runId>.json
    const wfMetaDir = path.join(claudeProjectPath, uuid, "workflows");

    for (const wfId of wfIds) {
      const wfDir = path.join(workflowsDir, wfId);
      const wfAgentFiles = fs
        .readdirSync(wfDir)
        .filter((f) => f.startsWith("agent-") && f.endsWith(".jsonl"));
      if (wfAgentFiles.length === 0) continue;

      const runLabel = resolveWorkflowRunLabel(wfMetaDir, wfId);
      const wfTargetDir = path.join(branchDir, `${ts}-${prefix}-workflows`, runLabel);
      for (const agentFile of wfAgentFiles) {
        const agentId = agentFile.replace("agent-", "").replace(".jsonl", "");
        try {
          const agentLines = readLines(path.join(wfDir, agentFile));
          const agentTs = formatTimestamp(getLastTimestamp(agentLines));
          exportFile(
            agentLines,
            agentId,
            path.join(wfTargetDir, `${agentTs}-${agentId}.md`),
          );
        } catch (e) {
          console.error(`    Workflow agent error (${wfId}/${agentId}): ${e}`);
        }
      }
      console.log(`    + workflow ${runLabel}: ${wfAgentFiles.length} agent(s)`);
    }
  }

  console.log("\nDone");
}

main();
