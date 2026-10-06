// html/format — shared HTML-escaping and number/time formatters for the
// report generators. Browser <script> copies stay inlined; they cannot
// import this module.

export function escape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Escape for an HTML attribute value (data-tip / title): collapse newlines.
export function attr(text: string): string {
  return escape(text).replace(/\n+/g, " ⏎ ");
}

export function fmtMoney(n: number): string {
  return "$" + n.toFixed(2);
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(Math.round(n));
}

export function fmtDuration(sec: number): string {
  const s = Math.round(sec);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m < 60) return `${m}m ${r}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function fmtOffset(sec: number): string {
  const s = Math.round(sec);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

// Display name for the coding agent (harness) that produced a conversation.
// One map shared by every report surface — index, discussion, dashboard,
// simulation — so a new source gets its label added in exactly one place.
const SOURCE_LABEL: Record<string, string> = {
  "claude-code": "Claude Code",
  opencode: "OpenCode",
  cursor: "Cursor",
};

// Absent means Claude Code (the sidecar omits `source` for it); an id the map
// doesn't know is shown verbatim rather than mislabelled.
export function sourceLabel(source?: string): string {
  const id = source ?? "claude-code";
  return SOURCE_LABEL[id] ?? id;
}
