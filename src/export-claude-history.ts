#!/usr/bin/env tsx
// export-claude-history v1.6

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
const claudeProjectPath = `${process.env["HOME"]}/.claude/projects/${projectRoot.replace(/\//g, "-")}`;
const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const fullExport = process.argv.includes("--full");
const targetDirArg = args[0];

if (!targetDirArg) {
  console.error("Usage: export-claude-history <target-dir> [--full]");
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
  message?: { role?: string; content?: string | ContentBlock[] };
  timestamp?: string;
  gitBranch?: string;
  toolUseResult?: unknown;
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
