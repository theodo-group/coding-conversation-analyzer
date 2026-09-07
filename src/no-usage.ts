// no-usage — the one place the "this source records no tokens" notice is worded.
//
// Cursor writes `{"inputTokens": 0, "outputTokens": 0}` for every message on
// disk, because it meters usage server-side. Suppressing the cost panels is
// necessary but not sufficient: a silently missing panel is indistinguishable
// from one that rendered zero, and both read as a claim about the session. So
// every artefact — the exported markdown and each generated HTML page — states
// outright that the figures are unavailable, and why.
//
// The wording lives here rather than being retyped per surface so it stays
// identical and greppable across all five insertion points (markdown
// frontmatter, markdown body, dashboard, discussion viewer, index).
//
// Tone note: this is a statement of provenance, not a warning. The data that
// *is* present is complete, and the last sentence says so.

import type { SourceId } from "./sources/types.ts";

const AGENT_LABEL: Partial<Record<SourceId, string>> = {
  cursor: "Cursor",
};

export function agentLabel(source: SourceId | undefined): string {
  return (source && AGENT_LABEL[source]) || "This agent";
}

/** Headline sentence, bold in every rendering. */
export function noUsageHeadline(source: SourceId | undefined): string {
  return `Token counts are not available for ${agentLabel(source)} sessions.`;
}

/** The explanation that follows the headline. Plain text, no markup. */
export function noUsageBody(source: SourceId | undefined): string {
  return (
    `${agentLabel(source)} does not record per-message token usage on disk ` +
    `(every tokenCount is zero); usage is metered server-side. Cost, cache and ` +
    `token-per-turn figures are therefore omitted rather than estimated. ` +
    `Message, tool, timing and diff data are complete.`
  );
}

/** One-line form, for a stat tile's tooltip or an index footnote. */
export function noUsageShort(source: SourceId | undefined): string {
  return `${agentLabel(source)} does not record token usage on disk, so cost cannot be computed.`;
}

/**
 * The markdown blockquote inserted between the frontmatter and the first
 * message block. This is the surface most likely to be read out of context —
 * pasted into a PR, an issue, a doc — so it carries the full sentences rather
 * than a bare flag.
 */
export function noUsageMarkdown(source: SourceId | undefined): string {
  return `> **${noUsageHeadline(source)}** ${noUsageBody(source)}\n`;
}
