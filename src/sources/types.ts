// sources/types — the neutral intermediate every source adapter produces.
//
// It is deliberately shaped like what the markdown + sidecar builders already
// consumed (a chronological list of messages, each holding content blocks), so
// adding a source means writing a reader, not forking the exporter. Everything
// source-specific — Claude Code's jsonl line types and snake_case tool inputs,
// OpenCode's SQLite rows and camelCase ones, Cursor's fused tool bubbles — is
// resolved inside the adapter.

import type { ModelCatalog } from "../models.ts";

// Which coding agent produced a conversation.
export type SourceId = "claude-code" | "opencode" | "cursor";

export interface Usage {
  in: number;
  out: number;
  cw: number; // cache creation (write)
  cr: number; // cache read
}

// What a content block is, already classified. The adapter decides — the
// exporter only renders — because the signals that separate, say, a human turn
// from a slash-command echo are entirely source-specific.
export type BlockKind =
  | "assistant_text"
  | "user_text" // a real human turn
  | "skill_prompt" // the injected "Base directory for this skill:" preamble
  | "skill_call" // the user invoking a slash command
  | "local_command" // local-command echo/caveat noise around an invocation
  | "notification" // an async subagent reporting back
  | "thinking"
  | "tool_use"
  | "tool_result"
  | "compaction"; // the context window was compacted at this point

// A real unified diff, when the source records one rather than leaving the
// exporter to approximate it from the edit's before/after strings.
export interface ExactDiff {
  file: string;
  patch: string;
  additions: number;
  deletions: number;
}

export interface NeutralBlock {
  kind: BlockKind;
  text?: string;
  // When the source times individual events rather than whole messages (OpenCode
  // stamps every part, and every tool call's start and end). Falls back to the
  // message's timestamp.
  ts?: string;

  // tool_use
  id?: string;
  // Canonical tool name (`Read`, `Edit`, `Bash`, `Agent`, …). Adapters map their
  // native names onto these so bucketing and input formatting stay shared.
  tool?: string;
  // Name to show in the transcript, when the source's own name is worth keeping
  // (e.g. OpenCode's `webfetch`). Defaults to `tool`.
  displayTool?: string;
  // Tool input under canonical keys (`file_path`, `old_string`, `command`, …).
  input?: Record<string, unknown>;
  // Exact diff for an edit, when the source supplies one.
  diff?: ExactDiff;
  // Agent/Task spawns: the child transcript's id and the model it ran on, when
  // the source states them outright instead of burying them in the result text.
  agentId?: string;
  subagentModel?: string;

  // tool_result
  toolUseId?: string;
  status?: "ok" | "error" | "rejected";
  // Size of the result the model had to read, for the simulator's
  // context-weight apportioning across parallel tools in one turn.
  outChars?: number;
}

export interface NeutralMessage {
  role: "user" | "assistant";
  ts: string; // ISO
  model?: string; // `<provider>/<model>` where a source has providers
  usage?: Usage;
  // What the session was in at this point: Claude Code's permission mode, or
  // OpenCode's agent/mode. `NeutralSession.source` says which.
  permissionMode?: string;
  blocks: NeutralBlock[];
}

export interface NeutralSession {
  uuid: string;
  sessionId: string;
  cwd: string;
  version: string;
  branch: string;
  branchSource?: "snapshot" | "live-git" | "unknown";
  source: SourceId;
  // A real session title when the source generates one; otherwise absent and
  // the exporter falls back to the first human prompt.
  title?: string;
  // First and last timestamps seen in the source, in source order (not min/max)
  // — everything on the timeline is measured from `firstTimestamp`.
  firstTimestamp: string;
  lastTimestamp: string;
  messages: NeutralMessage[];
  // Band transitions, in seconds from `firstTimestamp`. Adapters emit a
  // transition at t=0 so the band always covers the whole session.
  modeTransitions: Array<{ t: number; mode: string }>;
  // Catalog entries for models the built-in one doesn't know, keyed exactly as
  // `NeutralMessage.model`. Embedded in the sidecar so reports price correctly
  // without the checked-in catalog having to cover every provider.
  models?: ModelCatalog;
  // Set to false by a source that records no per-message token usage at all
  // (Cursor meters server-side and writes zeros to disk). Absent means the
  // usage on each message is real, which is what every source but Cursor does.
  // Reports must branch on this rather than rendering the zeros: a $0.00 is a
  // claim about the session, and it would be the wrong one.
  usageAvailable?: boolean;
  // A source's own estimate of what filled the context window, by category.
  // Cursor records this and no usage; it is what the reports show in the
  // cost chart's place. Nothing else supplies it.
  contextBreakdown?: ContextBreakdown;
}

// Estimated context occupancy by category, as the source computed it.
export interface ContextBreakdown {
  usedTokens: number;
  maxTokens: number;
  categories: Array<{ id: string; label: string; tokens: number }>;
}

// One subagent/workflow transcript spawned by a conversation. `group` names the
// workflow run it belongs to; a plain subagent has none.
export interface NeutralTranscript {
  id: string;
  session: NeutralSession;
  group?: string;
}

export interface NeutralConversation {
  session: NeutralSession;
  subagents: NeutralTranscript[];
  workflows: NeutralTranscript[];
}

export interface SetupItem {
  // `rule` is Cursor's `.cursor/rules/*.mdc` — always-on instructions injected
  // into the system prompt, with no analog in the other sources.
  kind: "agent" | "skill" | "command" | "plugin" | "rule";
  name: string;
  description: string;
}

// A session the adapter can export, cheap to enumerate: the driver compares
// `mtime` against the existing export before paying to load the transcript.
export interface SourceSessionRef {
  uuid: string;
  // Short, filename-safe, source-unique stem — `<timestamp>-<prefix>.md`.
  prefix: string;
  mtime: number;
}

export interface SourceAdapter {
  readonly source: SourceId;
  // Human-readable description of where this adapter is reading from.
  readonly origin: string;
  // Sessions this source holds for the current project root.
  list(): SourceSessionRef[];
  load(ref: SourceSessionRef): NeutralConversation;
  // Agents/skills/commands configured for this source, for the setup panel.
  setup(): { project: SetupItem[]; user: SetupItem[] };
}

export function emptyUsage(): Usage {
  return { in: 0, out: 0, cw: 0, cr: 0 };
}

export function addUsage(acc: Usage, u: Usage): void {
  acc.in += u.in;
  acc.out += u.out;
  acc.cw += u.cw;
  acc.cr += u.cr;
}

// Every message of a conversation and all its child transcripts, so aggregation
// (token totals, dominant model, tool tallies) can be written once and reused by
// both sources — the reading is what differs, not the summing.
export function* allTranscripts(c: NeutralConversation): Generator<NeutralSession> {
  yield c.session;
  for (const t of c.subagents) yield t.session;
  for (const t of c.workflows) yield t.session;
}
