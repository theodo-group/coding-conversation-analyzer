// sources/sqlite — open a coding agent's SQLite store read-only.
//
// Two adapters now read SQLite databases that belong to a *running* application
// (OpenCode's `opencode.db`, Cursor's `state.vscdb`), so the same three
// constraints apply to both and the open lives here rather than being copied:
//
//   - read-only, always: we are a guest in someone else's database
//   - the write-ahead log must be replayed, or a session written seconds ago is
//     invisible (Cursor's `-wal` runs to half the size of the main file)
//   - `node:sqlite` is loaded lazily and via `require`, so a Claude-only export
//     doesn't pay for it, and so its "SQLite is an experimental feature" notice
//     can be muted for this one call instead of globally

import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";

const requireNode = createRequire(import.meta.url);

export function openDatabase(file: string): DatabaseSync {
  const prev = process.emitWarning;
  process.emitWarning = ((warning: unknown, ...rest: unknown[]) => {
    if (String(warning).includes("SQLite is an experimental feature")) return;
    (prev as (...a: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    const sqlite = requireNode("node:sqlite") as typeof import("node:sqlite");
    // `readOnly` still replays the WAL — SQLite reads `-wal`/`-shm` to serve a
    // consistent snapshot — so an export taken while the agent is mid-session
    // sees the messages it just wrote.
    return new sqlite.DatabaseSync(file, { readOnly: true });
  } finally {
    process.emitWarning = prev;
  }
}
