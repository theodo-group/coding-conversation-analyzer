// Single source of truth for the tool version.
//
// The version lives in exactly one place — the `version` field of package.json
// — and every other surface (CLI `--version`, exported markdown, generated
// HTML, the installer banner) derives it from here. See CLAUDE.md → Versioning
// for the release policy.

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json");

/** The tool's semantic version, read from package.json. */
export const VERSION: string = (() => {
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

/**
 * If `argv` requests the version (`--version` / `-v`), print `<name> <version>`
 * and exit. Call this before any other argument handling in a CLI entry point.
 */
export function handleVersionFlag(argv: readonly string[], name: string): void {
  if (argv.includes("--version") || argv.includes("-v")) {
    console.log(`${name} ${VERSION}`);
    process.exit(0);
  }
}
