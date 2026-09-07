#!/usr/bin/env tsx
// export-claude-history — backward-compatible alias for `export-history`.
//
// The exporter is source-agnostic now (Claude Code *and* OpenCode), so it lives
// in `export-history.ts`. This entry point stays so existing installs, scripts
// and the `cca-export` wrapper keep working; it forwards every argument through.
// Mirrors how `cca-export` already aliases `cca export`.

import "./export-history.ts";
