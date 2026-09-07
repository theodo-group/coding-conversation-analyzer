// sidecar — the dashboard JSON shape written by export-history and read by
// the HTML generators. One module so writer and readers cannot drift (they
// already had: dashboard dropped `outChars` and narrowed `SetupItem`).
//
// Additive fields are optional so sidecars written before those fields
// existed still type-check. Domain types (`Usage`, `SetupItem`, `ModelEntry`)
// live in their own modules and are imported, not redeclared.

import type { ModelEntry } from "./models.ts";
import type { ContextBreakdown, SetupItem, SourceId, Usage } from "./sources/types.ts";

// A single event on the message timeline. `t` is seconds from session start.
export interface TimelinePoint {
  i: number;
  kind:
    | "prompt"
    | "assistant"
    | "thinking"
    | "tool_use"
    | "tool_result"
    | "notification"
    | "skill"
    | "compaction";
  t: number;
  model?: string; // model that issued the message/call (the caller)
  subagentModel?: string; // for Agent/Task spawns: the model the subagent ran on
  tool?: string;
  label?: string; // short text preview (prompts, tool inputs)
  permissionMode?: string;
  usage?: Usage; // present on assistant API calls only
  outChars?: number; // tool_result points: size of the result content, for
  // apportioning a turn's context weight across parallel tools in the simulator
}

export interface SubagentSpawn {
  type: string;
  description: string;
  input: string;
  t: number;
  // Model the subagent actually ran on (resolved from its transcript), not the
  // orchestrator model that issued the spawn. Absent if it can't be resolved.
  model?: string;
}

export interface DiffLine {
  type: "add" | "del" | "ctx";
  text: string;
}

export interface ToolCounts {
  read: number;
  search: number;
  bash: number;
  edit: number;
  other: number;
}

export interface DiffEntry {
  op: "Write" | "Edit";
  filePath: string;
  added: number;
  removed: number;
  hunk: DiffLine[];
  // "main" = issued by the main thread; "subagent" = issued inside a
  // subagent/workflow transcript. Absent is treated as "main" by readers.
  origin?: "main" | "subagent";
}

export interface PermissionSegment {
  mode: string;
  start: number; // seconds
  end: number; // seconds
}

export interface Sidecar {
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
  // Top-level line/tool counts are whole-session totals (main thread +
  // subagents). `subagent` breaks out the subagent-only portion so the
  // dashboard can show a main-vs-subagent split (main = total − subagent),
  // mirroring how cost is split via subagentUsageByModel.
  stats: {
    humanTurns: number;
    linesAdded: number;
    linesRemoved: number;
    toolCounts: ToolCounts;
    subagent: {
      linesAdded: number;
      linesRemoved: number;
      toolCounts: ToolCounts;
    };
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
  // Which agent produced the conversation. Absent means Claude Code, so
  // sidecars written before OpenCode support still read correctly.
  source?: SourceId;
  // False when the source records no token usage at all (Cursor). Absent means
  // the usage on the timeline is real — which is how every sidecar written
  // before Cursor support reads. Readers must render cost and context as
  // unavailable rather than as zero when this is false; see the disclaimer in
  // the dashboard and the exported markdown.
  usageAvailable?: boolean;
  // The source's own estimate of what filled the context window, by category.
  // Shown in place of the cost/context chart when `usageAvailable` is false.
  contextBreakdown?: ContextBreakdown;
  // Price/limit entries for models the built-in catalog doesn't know, keyed
  // exactly as `TimelinePoint.model`. models.dev shape, verbatim.
  models?: Record<string, ModelEntry>;
  // How `branch` was determined, when the source doesn't record one outright.
  branchSource?: "snapshot" | "live-git" | "unknown";
}
