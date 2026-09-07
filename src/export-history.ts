#!/usr/bin/env tsx
// export-history — export coding-agent conversations to markdown.
//
// Source-agnostic: a `SourceAdapter` (see `sources/`) turns whatever a coding
// agent stores on disk into the neutral intermediate, and everything below —
// markdown rendering, the dashboard sidecar, the output layout — is shared.
// Claude Code reads jsonl transcripts; OpenCode reads its SQLite database.
//
// Version is unified project-wide; see package.json and CLAUDE.md → Versioning.

import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { VERSION, handleVersionFlag } from "./version.ts";
import type {
  DiffEntry,
  DiffLine,
  PermissionSegment,
  Sidecar,
  SubagentSpawn,
  TimelinePoint,
  ToolCounts,
} from "./sidecar.ts";
import { ClaudeAdapter } from "./sources/claude.ts";
import { OpenCodeAdapter } from "./sources/opencode.ts";
import {
  addUsage,
  emptyUsage,
  type NeutralBlock,
  type NeutralConversation,
  type NeutralSession,
  type NeutralTranscript,
  type SetupItem,
  type SourceAdapter,
  type SourceSessionRef,
  type Usage,
} from "./sources/types.ts";

function getProjectRoot(): string {
  try {
    return execSync("git rev-parse --show-toplevel", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return process.cwd();
  }
}

const projectRoot = getProjectRoot();

// --- CLI ---

type SourceName = "claude" | "opencode";
const SOURCE_NAMES: SourceName[] = ["claude", "opencode"];

const rawArgs = process.argv.slice(2);
handleVersionFlag(rawArgs, "cca-export");
const fullExport = rawArgs.includes("--full");
const positional: string[] = [];
let claudeDirArg: string | undefined;
let openCodeDirArg: string | undefined;
let sourceArg = "auto";

for (let i = 0; i < rawArgs.length; i++) {
  const a = rawArgs[i];
  if (a === undefined) continue;
  if (a === "--full") continue;
  const opt = (name: string): string | undefined => {
    if (a === `--${name}`) return rawArgs[++i];
    if (a.startsWith(`--${name}=`)) return a.slice(name.length + 3);
    return undefined;
  };
  const cd = opt("claude-dir");
  if (cd !== undefined) {
    claudeDirArg = cd;
    continue;
  }
  const od = opt("opencode-dir");
  if (od !== undefined) {
    openCodeDirArg = od;
    continue;
  }
  const sr = opt("source");
  if (sr !== undefined) {
    sourceArg = sr;
    continue;
  }
  if (a.startsWith("--")) continue;
  positional.push(a);
}

const USAGE =
  "Usage: cca-export <target-dir> [--full] [--source claude|opencode|auto]\n" +
  "                  [--claude-dir <path>] [--opencode-dir <path>] [--version]";

if (sourceArg !== "auto" && !SOURCE_NAMES.includes(sourceArg as SourceName)) {
  console.error(`Error: unknown --source ${JSON.stringify(sourceArg)}. Expected auto, claude or opencode.`);
  process.exit(1);
}

const targetDirArg = positional[0];
if (!targetDirArg) {
  console.error(USAGE);
  process.exit(1);
}

const targetDir = path.isAbsolute(targetDirArg)
  ? targetDirArg
  : path.join(projectRoot, targetDirArg);

// --- Helpers ---

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

// Render a tool's input for the transcript. Keyed on the *canonical* tool names
// and input keys — adapters normalise their source's own names onto these, so
// this stays source-agnostic.
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

function splitLines(s: string): string[] {
  return s.replace(/\n$/, "").split("\n");
}

// --- Parsing: neutral session → markdown blocks ---

function parseConversation(session: NeutralSession) {
  const messages: string[] = [];
  const categories: Record<string, number> = {};

  // Per-message context window (input + cache-write + cache-read), tracked in
  // parallel with `messages` so each rendered block can be tagged with how full
  // the window was. `currentMsgCtx` is the value for the message being emitted;
  // `pushMsg` snapshots it alongside every block. Assistant messages carry a
  // real value (their API call's window); user/tool blocks are left undefined
  // and forward-filled below to the next call that consumes them.
  let currentMsgCtx: number | undefined;
  const ctxs: (number | undefined)[] = [];
  const pushMsg = (md: string): void => {
    messages.push(md);
    ctxs.push(currentMsgCtx);
  };

  const count = (key: string) => {
    categories[key] = (categories[key] || 0) + 1;
  };

  for (const msg of session.messages) {
    // Window size for this message's blocks: only assistant API calls report a
    // usage, and input + cache-write + cache-read is the full prompt that call
    // saw. User/tool messages have none (they are inputs to the next call).
    currentMsgCtx =
      msg.role === "assistant" && msg.usage
        ? msg.usage.in + msg.usage.cw + msg.usage.cr || undefined
        : undefined;

    for (const b of msg.blocks) {
      const text = b.text ?? "";
      switch (b.kind) {
        case "notification":
          count("task_notification");
          pushMsg(`\n## 🔔 Task Notification\n${formatTaskNotification(text)}`);
          break;
        case "skill_call":
          count("skill_call");
          pushMsg(`\n## 🧑 User calling skill\n${formatCommandMessage(text)}`);
          break;
        case "skill_prompt":
          count("skill_prompt");
          pushMsg(`\n## 📜 Skill Prompt\n${text}`);
          break;
        // Local-command echoes read as the user's own turn in the transcript,
        // even though the metrics pass counts them as tooling noise.
        case "local_command":
        case "user_text":
          count("user");
          pushMsg(`\n## 🧑 User\n${text}`);
          break;
        case "assistant_text":
          count("assistant");
          pushMsg(`\n## 🤖 Assistant\n${text}`);
          break;
        case "thinking":
          count("thinking");
          pushMsg(`\n## 🧠 Thinking\n${text}`);
          break;
        case "compaction":
          count("compaction");
          pushMsg(`\n## 🗜️ Context Compaction\n${text || "The conversation was compacted here."}`);
          break;
        case "tool_use": {
          const name = b.tool as string;
          count(`tool_call:${b.displayTool ?? name}`);
          // A spawn block carries the child transcript's id, so the viewer can
          // link the call straight into the subagent's own discussion page.
          const link = b.agentId ? `\n\n[[agent:${b.agentId}]]` : "";
          pushMsg(
            `\n## ⚪️ Tool Call: ${b.displayTool ?? name}\n${formatToolInput(name, b.input)}${link}`,
          );
          break;
        }
        case "tool_result": {
          // Heading shows the source's own tool name; the indent rule keys off
          // the canonical one, since it is about what the output looks like.
          const canonical = b.tool || "unknown";
          const shown = b.displayTool ?? canonical;
          const body =
            canonical === "Grep" || canonical === "Read" || canonical === "Bash"
              ? "    " + truncate(text).split("\n").join("\n    ")
              : truncate(text);
          if (b.status === "rejected") {
            count("tool_rejected");
            pushMsg(`\n## ❌ Tool Rejected: ${shown}\n${body}`);
          } else if (b.status === "error") {
            count("tool_error");
            pushMsg(`\n## 🔴 Tool Error: ${shown}\n${body}`);
          } else if (body.trim()) {
            count("tool_result");
            pushMsg(`\n## 🟢 Tool Result: ${shown}\n${body}`);
          }
          break;
        }
      }
    }
  }

  // Forward-fill so every block carries a window size: an input block (user
  // prompt, tool result) shows the window of the next API call that consumes
  // it, while the model's own output blocks keep their producing call's window.
  let nextCtx: number | undefined;
  for (let k = ctxs.length - 1; k >= 0; k--) {
    if (ctxs[k] !== undefined) nextCtx = ctxs[k];
    else ctxs[k] = nextCtx;
  }
  // Tag each heading with a hidden marker the HTML viewer reads (and strips).
  // An HTML comment stays invisible in plain-markdown renderers.
  for (let k = 0; k < messages.length; k++) {
    const c = ctxs[k];
    if (c === undefined) continue;
    messages[k] = messages[k]!.replace(/^\n(## [^\n]*)/, `\n$1 <!--cca-ctx:${c}-->`);
  }

  return {
    messages,
    firstTimestamp: session.firstTimestamp,
    lastTimestamp: session.lastTimestamp,
    branch: session.branch,
    categories,
    uuid: session.uuid,
  };
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
  { key: "compaction", emoji: "🗜️", label: "Compaction" },
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

// --- Export bookkeeping ---

// Map each source uuid to every already-exported session .md for it. Normally
// one, but stale duplicates can pile up as the session timestamp advances — we
// track them all so a re-export can clear the lot.
function findExistingExports(refs: SourceSessionRef[]): Map<string, string[]> {
  const exported = new Map<string, string[]>();
  if (!fs.existsSync(targetDir)) return exported;

  const prefixToUuids = new Map<string, string[]>();
  for (const ref of refs) {
    if (!prefixToUuids.has(ref.prefix)) prefixToUuids.set(ref.prefix, []);
    prefixToUuids.get(ref.prefix)!.push(ref.uuid);
  }

  // Scan target dir for existing session exports. Session files are
  // `<ts>-<prefix>.md`; the prefix is whatever short stem the source chose, so
  // the pattern has to admit OpenCode's mixed-case non-hex ids as well as
  // Claude Code's 8 hex characters. Agent transcripts sit in sibling
  // `-subagents`/`-workflows` dirs and simply never match a known prefix.
  function scan(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        scan(full);
        continue;
      }
      const m = entry.name.match(
        /^(\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2})-([a-zA-Z0-9_]{8,32})\.(md|txt)$/,
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

function exportTranscript(session: NeutralSession, targetFile: string): boolean {
  const stats = parseConversation(session);
  if (!stats.messages.join("").trim()) return false;
  fs.mkdirSync(path.dirname(targetFile), { recursive: true });
  fs.writeFileSync(targetFile, formatHeader(stats) + stats.messages.join("\n"));
  return true;
}

// --- Sidecar (dashboard data) extraction ---

// Version tag for the embedded metadata block, bumped if its JSON shape ever
// changes so readers can detect an incompatible format. The OpenCode fields are
// all additive, so v1 readers still parse a v1 sidecar written for either source.
const CCA_DATA_VERSION = 1;

// Render the sidecar as a trailing HTML comment appended to the .md. HTML
// comments are invisible in any rendered markdown, so the human-readable
// conversation is untouched, while `cca-generate-html` can parse the block back
// out to build the dashboard. Returns "" when no sidecar was built.
function embedSidecar(sidecar: Sidecar | null): string {
  if (!sidecar) return "";
  // The marker records both the data-format version (`v`, bumped only on schema
  // changes) and the tool version that wrote it (`tool`, the project semver).
  return `\n\n<!-- cca:data v=${CCA_DATA_VERSION} tool=${VERSION}\n${JSON.stringify(sidecar)}\n-->\n`;
}

function emptyToolCounts(): ToolCounts {
  return { read: 0, search: 0, bash: 0, edit: 0, other: 0 };
}

function addToolCounts(acc: ToolCounts, t: ToolCounts): void {
  acc.read += t.read;
  acc.search += t.search;
  acc.bash += t.bash;
  acc.edit += t.edit;
  acc.other += t.other;
}

// Canonical tool names → the dashboard's activity buckets. Adapters map their
// source's own names onto the canonical set, and the lookup is case-insensitive
// so a source that emits lowercase names still lands in the right bucket
// instead of collapsing into `other`.
const TOOL_BUCKETS: Record<string, keyof ToolCounts> = {
  read: "read",
  glob: "search",
  grep: "search",
  bash: "bash",
  edit: "edit",
  multiedit: "edit",
  write: "edit",
};

function bucketOf(name: string): keyof ToolCounts {
  return TOOL_BUCKETS[name.toLowerCase()] ?? "other";
}

// Sum token usage by model across a transcript (used for subagents).
function sumUsageByModel(session: NeutralSession, acc: Record<string, Usage>): void {
  for (const msg of session.messages) {
    if (msg.role !== "assistant" || !msg.model || !msg.usage) continue;
    if (!acc[msg.model]) acc[msg.model] = emptyUsage();
    addUsage(acc[msg.model]!, msg.usage);
  }
}

// Pick the model that produced the most output tokens in a transcript. Used to
// label an Agent/Task spawn with the model the subagent actually ran on, rather
// than the orchestrator model that issued the spawn.
function dominantModelOf(session: NeutralSession): string | undefined {
  const byModel: Record<string, number> = {};
  for (const msg of session.messages) {
    if (msg.role !== "assistant" || !msg.model) continue;
    byModel[msg.model] = (byModel[msg.model] || 0) + (msg.usage?.out || 0);
  }
  let best: string | undefined;
  let bestN = -1;
  for (const [m, n] of Object.entries(byModel)) {
    if (n > bestN) {
      bestN = n;
      best = m;
    }
  }
  return best;
}

// Tally tool calls and collect Write/Edit diffs across a transcript. Shared with
// the main-thread pass in buildSidecar; used here to harvest subagents.
function harvestToolUse(
  session: NeutralSession,
  diffs: DiffEntry[],
  toolCounts: ToolCounts,
  origin: "main" | "subagent",
): void {
  for (const msg of session.messages) {
    if (msg.role !== "assistant") continue;
    for (const b of msg.blocks) {
      if (b.kind !== "tool_use") continue;
      toolCounts[bucketOf(b.tool || "")]++;
      const d = diffFromToolUse(b, origin);
      if (d) diffs.push(d);
    }
  }
}

// Fold every subagent/workflow transcript's file edits and tool usage into
// whole-session activity, so the dashboard reports the whole conversation and
// not just its main thread.
function accumulateSubagentActivity(children: NeutralTranscript[]): {
  diffs: DiffEntry[];
  toolCounts: ToolCounts;
  linesAdded: number;
  linesRemoved: number;
} {
  const diffs: DiffEntry[] = [];
  const toolCounts = emptyToolCounts();
  for (const child of children) harvestToolUse(child.session, diffs, toolCounts, "subagent");
  return {
    diffs,
    toolCounts,
    linesAdded: diffs.reduce((s, d) => s + d.added, 0),
    linesRemoved: diffs.reduce((s, d) => s + d.removed, 0),
  };
}

// Single pass over the main transcript to produce the dashboard sidecar
// (minus subagent usage + setup, which the caller fills in).
function buildSidecar(conv: NeutralConversation): Sidecar {
  const session = conv.session;
  const timeline: TimelinePoint[] = [];
  const subagents: SubagentSpawn[] = [];
  const diffs: DiffEntry[] = [];
  const toolCounts = emptyToolCounts();

  let title = session.title ?? "";
  let humanTurns = 0;

  // Map each subagent id to the model it ran on, read from its own transcript.
  // Lets an Agent/Task spawn report the subagent's model rather than the
  // orchestrator's.
  const subagentModelById = new Map<string, string>();
  for (const child of conv.subagents) {
    const m = dominantModelOf(child.session);
    if (m) subagentModelById.set(child.id, m);
  }

  const firstTs = session.firstTimestamp;
  const toSec = (ts: string): number =>
    firstTs && ts ? (new Date(ts).getTime() - new Date(firstTs).getTime()) / 1000 : 0;

  let i = 0;
  for (const msg of session.messages) {
    const model = msg.model;
    const pm = msg.permissionMode;
    let usageAttached = false;

    for (const b of msg.blocks) {
      // A source that times individual events (OpenCode stamps each part, and
      // each tool call's start and end) places its points precisely; one that
      // only times messages puts every block at the message's own timestamp.
      const t = toSec(b.ts ?? msg.ts);
      switch (b.kind) {
        case "notification":
          timeline.push({ i: i++, kind: "notification", t });
          break;
        // Slash commands and injected skill preambles are tooling noise around a
        // turn, not a turn of their own — they never count as a human prompt.
        case "skill_call":
        case "local_command":
        case "skill_prompt":
          timeline.push({ i: i++, kind: "skill", t });
          break;
        case "user_text": {
          humanTurns++;
          const txt = (b.text ?? "").trim();
          if (!title) title = txt;
          timeline.push({ i: i++, kind: "prompt", t, label: truncate(txt, 400) });
          break;
        }
        case "thinking":
          timeline.push({ i: i++, kind: "thinking", t, ...(model ? { model } : {}) });
          break;
        case "compaction":
          timeline.push({ i: i++, kind: "compaction", t, ...(model ? { model } : {}) });
          break;
        case "assistant_text": {
          const point: TimelinePoint = { i: i++, kind: "assistant", t };
          if (model) point.model = model;
          if (pm) point.permissionMode = pm;
          if (!usageAttached && msg.usage) {
            point.usage = msg.usage;
            usageAttached = true;
          }
          timeline.push(point);
          break;
        }
        case "tool_use": {
          const name = b.tool || "";
          toolCounts[bucketOf(name)]++;
          const point: TimelinePoint = { i: i++, kind: "tool_use", t, tool: b.displayTool ?? name };
          if (model) point.model = model;
          if (!usageAttached && msg.usage) {
            point.usage = msg.usage;
            usageAttached = true;
          }
          timeline.push(point);

          if (name === "Agent" || name === "Task") {
            const inp = (b.input ?? {}) as Record<string, unknown>;
            const spawn: SubagentSpawn = {
              type: String(inp["subagent_type"] ?? inp["agentType"] ?? "agent"),
              description: String(inp["description"] ?? ""),
              input: truncate(String(inp["prompt"] ?? ""), 600),
              t,
            };
            subagents.push(spawn);
            // `point.model` above is the orchestrator's model; `subagentModel`
            // is the model the subagent itself ran on.
            const sub =
              b.subagentModel ?? (b.agentId ? subagentModelById.get(b.agentId) : undefined);
            if (sub) {
              point.subagentModel = sub;
              spawn.model = sub;
            }
          }
          const d = diffFromToolUse(b, "main");
          if (d) diffs.push(d);
          break;
        }
        case "tool_result":
          timeline.push({
            i: i++,
            kind: "tool_result",
            t,
            ...(b.outChars ? { outChars: b.outChars } : {}),
          });
          break;
      }
    }
  }

  const durationSeconds =
    session.firstTimestamp && session.lastTimestamp
      ? (new Date(session.lastTimestamp).getTime() -
          new Date(session.firstTimestamp).getTime()) /
        1000
      : 0;

  // Build band segments spanning [start, end]. Adapters emit a transition at
  // t=0, so a source with no band signal at all still gets one flat segment.
  const permissionSegments: PermissionSegment[] = [];
  const transitions = session.modeTransitions.length
    ? session.modeTransitions
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

  const sidecar: Sidecar = {
    uuid: session.uuid,
    sessionId: session.sessionId || session.uuid,
    cwd: session.cwd,
    branch: session.branch,
    version: session.version,
    title,
    start: session.firstTimestamp,
    end: session.lastTimestamp,
    durationSeconds,
    timeZone,
    // Top-level counts start as main-thread only; the caller folds in
    // subagent activity (see accumulateSubagentActivity) to make them
    // whole-session totals, alongside subagentUsageByModel for cost.
    stats: {
      humanTurns,
      linesAdded,
      linesRemoved,
      toolCounts,
      subagent: { linesAdded: 0, linesRemoved: 0, toolCounts: emptyToolCounts() },
    },
    timeline,
    permissionSegments,
    subagents,
    subagentUsageByModel: {},
    diffs,
    setup: { project: [], user: [] },
  };
  // Additive fields, only written when they say something — an absent `source`
  // means Claude Code, which is how every sidecar written so far reads.
  if (session.source !== "claude-code") sidecar.source = session.source;
  if (session.models && Object.keys(session.models).length) sidecar.models = session.models;
  if (session.branchSource) sidecar.branchSource = session.branchSource;
  return sidecar;
}

// Turn a Write/Edit tool call into a diff entry with a small preview hunk. When
// the source recorded a real unified diff (`block.diff`), use its exact counts
// and hunk; otherwise approximate from the edit's before/after strings.
function diffFromToolUse(block: NeutralBlock, origin: "main" | "subagent"): DiffEntry | null {
  const name = block.tool;
  if (name !== "Write" && name !== "Edit") return null;
  const obj = (block.input ?? {}) as Record<string, string | undefined>;

  if (block.diff) {
    const d = block.diff;
    return {
      op: name,
      filePath: d.file || obj["file_path"] || "",
      added: d.additions,
      removed: d.deletions,
      hunk: parsePatchHunk(d.patch),
      origin,
    };
  }

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
      origin,
    };
  }
  const oldLines = obj["old_string"] ? splitLines(obj["old_string"]) : [];
  const newLines = obj["new_string"] ? splitLines(obj["new_string"]) : [];
  const hunk: DiffLine[] = [
    ...oldLines.slice(0, 30).map((text) => ({ type: "del" as const, text })),
    ...newLines.slice(0, 30).map((text) => ({ type: "add" as const, text })),
  ];
  return { op: "Edit", filePath, added: newLines.length, removed: oldLines.length, hunk, origin };
}

// A unified diff → the viewer's preview hunk, dropping the `Index:`/`---`/`+++`/
// `@@` scaffolding and keeping the first 40 content lines.
function parsePatchHunk(patch: string): DiffLine[] {
  const out: DiffLine[] = [];
  for (const line of patch.split("\n")) {
    if (out.length >= 40) break;
    if (
      line.startsWith("Index:") ||
      line.startsWith("---") ||
      line.startsWith("+++") ||
      line.startsWith("@@") ||
      line.startsWith("===")
    ) {
      continue;
    }
    if (line.startsWith("+")) out.push({ type: "add", text: line.slice(1) });
    else if (line.startsWith("-")) out.push({ type: "del", text: line.slice(1) });
    else if (line.startsWith(" ")) out.push({ type: "ctx", text: line.slice(1) });
  }
  return out;
}

// --- Main ---

function buildAdapters(): SourceAdapter[] {
  const wanted: SourceName[] = sourceArg === "auto" ? SOURCE_NAMES : [sourceArg as SourceName];
  const out: SourceAdapter[] = [];
  for (const name of wanted) {
    if (name === "claude") {
      out.push(
        new ClaudeAdapter({
          projectRoot,
          ...(claudeDirArg ? { claudeDir: claudeDirArg } : {}),
          formatTimestamp,
        }),
      );
    } else {
      try {
        out.push(
          new OpenCodeAdapter({
            projectRoot,
            ...(openCodeDirArg ? { dataDir: openCodeDirArg } : {}),
          }),
        );
      } catch (e) {
        // An explicitly requested source that can't be opened is fatal; in
        // `auto` it just means this machine has no OpenCode data.
        if (sourceArg !== "auto") {
          console.error(`Error: ${e instanceof Error ? e.message : e}`);
          process.exit(1);
        }
      }
    }
  }
  return out;
}

function main() {
  console.log(`Export conversations → ${targetDir}\n`);

  const adapters = buildAdapters();
  const bySource = adapters.map((a) => ({ adapter: a, refs: a.list() }));
  const allRefs = bySource.flatMap((s) => s.refs);

  for (const { adapter, refs } of bySource) {
    console.log(`  ${adapter.source}: ${refs.length} conversation(s) — ${adapter.origin}`);
  }
  console.log("");

  if (!allRefs.length) {
    console.error(
      `Error: no conversations found for ${projectRoot}.\n` +
        bySource.map((s) => `  ${s.adapter.source}: ${s.adapter.origin}`).join("\n"),
    );
    process.exit(1);
  }

  const exported = findExistingExports(allRefs);
  const skipped = loadSkippedUuids();
  const username = getGitUsername();
  let exportedCount = 0;

  for (const { adapter, refs } of bySource) {
    const setup = adapter.setup();

    for (const ref of refs) {
      if (skipped.has(ref.uuid)) continue;

      const priors = exported.get(ref.uuid) ?? [];
      // Up to date only when exactly one export exists and it is newer than the
      // source; more than one means stale duplicates to clean up.
      if (
        priors.length === 1 &&
        priors[0] !== undefined &&
        fs.existsSync(priors[0]) &&
        fs.statSync(priors[0]).mtimeMs >= ref.mtime
      ) {
        continue;
      }

      let conv: NeutralConversation;
      try {
        conv = adapter.load(ref);
      } catch (e) {
        console.error(`  Load error (${ref.uuid}): ${e}`);
        continue;
      }

      const stats = parseConversation(conv.session);
      if (!stats.messages.join("").trim()) {
        saveSkippedUuid(ref.uuid);
        continue;
      }

      // Replace all prior exports (old timestamps + sidecar dirs) so re-exports
      // don't accumulate stale duplicates as the session timestamp advances.
      for (const prior of priors) {
        if (fs.existsSync(prior)) removeExportOutputs(prior);
      }

      const ts = formatTimestamp(stats.lastTimestamp);
      const branchDir = path.join(targetDir, username, sanitizeBranch(stats.branch));
      const base = `${ts}-${ref.prefix}`;

      // Build the dashboard sidecar first so it can be embedded directly in the
      // .md as a hidden data block — this makes the exported .md self-contained
      // (a standalone file renders both the discussion and dashboard views, with
      // no source transcript or sibling .json needed). Failure to build it is
      // non-fatal: the .md is still written, just without the embedded metrics.
      let sidecar: Sidecar | null = null;
      try {
        const children = [...conv.subagents, ...conv.workflows];
        sidecar = buildSidecar(conv);
        for (const child of children) sumUsageByModel(child.session, sidecar.subagentUsageByModel);
        // Fold subagent file edits + tool usage into whole-session totals, and
        // record the subagent-only portion for the dashboard's main/sub split.
        const subActivity = accumulateSubagentActivity(children);
        sidecar.diffs.push(...subActivity.diffs);
        sidecar.stats.linesAdded += subActivity.linesAdded;
        sidecar.stats.linesRemoved += subActivity.linesRemoved;
        addToolCounts(sidecar.stats.toolCounts, subActivity.toolCounts);
        sidecar.stats.subagent = {
          linesAdded: subActivity.linesAdded,
          linesRemoved: subActivity.linesRemoved,
          toolCounts: subActivity.toolCounts,
        };
        sidecar.setup = setup;
      } catch (e) {
        console.error(`    Sidecar error: ${e}`);
      }

      fs.mkdirSync(branchDir, { recursive: true });
      const targetFile = path.join(branchDir, `${base}.md`);
      fs.writeFileSync(
        targetFile,
        formatHeader(stats) + stats.messages.join("\n") + embedSidecar(sidecar),
      );
      // Print the absolute path so terminals render it as a clickable link.
      console.log(`  Exported: ${targetFile}`);
      exportedCount++;

      // Also emit the sidecar as a sibling .json. Redundant with the embedded
      // block above, kept for backward compatibility with older readers and for
      // callers that want the raw metrics without parsing the markdown.
      if (sidecar) {
        fs.writeFileSync(targetFile.replace(/\.md$/, ".json"), JSON.stringify(sidecar));
      }

      // Subagent transcripts land in a sibling `-subagents` dir; workflow agents
      // get a further per-run subdirectory. The HTML index nests both under this
      // conversation by reading that layout back off disk.
      const subTargetDir = path.join(branchDir, `${base}-subagents`);
      for (const child of conv.subagents) {
        const childTs = formatTimestamp(child.session.lastTimestamp);
        try {
          exportTranscript(child.session, path.join(subTargetDir, `${childTs}-${child.id}.md`));
        } catch (e) {
          console.error(`    Agent error (${child.id}): ${e}`);
        }
      }
      if (conv.subagents.length) console.log(`    + ${conv.subagents.length} subagent(s)`);

      const byRun = new Map<string, NeutralTranscript[]>();
      for (const wf of conv.workflows) {
        const key = wf.group ?? "workflow";
        (byRun.get(key) ?? byRun.set(key, []).get(key)!).push(wf);
      }
      for (const [runLabel, agents] of byRun) {
        const wfTargetDir = path.join(branchDir, `${base}-workflows`, runLabel);
        for (const wf of agents) {
          const childTs = formatTimestamp(wf.session.lastTimestamp);
          try {
            exportTranscript(wf.session, path.join(wfTargetDir, `${childTs}-${wf.id}.md`));
          } catch (e) {
            console.error(`    Workflow agent error (${runLabel}/${wf.id}): ${e}`);
          }
        }
        console.log(`    + workflow ${runLabel}: ${agents.length} agent(s)`);
      }
    }
  }

  console.log(`\n${exportedCount} conversation(s) exported.`);
  console.log("Done");
}

main();
