// project-roots — every directory a project's conversations may be keyed under.
//
// Coding agents key their history by working directory, but one project is not
// one directory: git worktrees (and tools built on them) give the same repo
// several roots, each with its own slice of the history. Conductor is the
// motivating case — it wraps Claude Code and runs every workspace as a worktree
// at `~/conductor/workspaces/<repo>/<name>`, so exporting from the main clone
// used to find none of the workspace sessions.
//
// Discovery is additive: the primary root always comes first, and a project
// with no worktrees and no Conductor workspaces resolves to just itself, so
// existing single-root exports are unchanged.

import { execSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export function conductorWorkspacesDir(): string {
  return path.join(os.homedir(), "conductor", "workspaces");
}

// The repo name Conductor files this project under: the project's own basename,
// or — when the export runs from inside a workspace — the workspace's parent
// directory, which Conductor names after the repo.
export function conductorRepoName(projectRoot: string): string {
  const p = path.resolve(projectRoot);
  if (path.dirname(path.dirname(p)) === conductorWorkspacesDir()) {
    return path.basename(path.dirname(p));
  }
  return path.basename(p);
}

// Primary root first, then every other root the project's history may be keyed
// under: the repo's registered git worktrees, and any Conductor workspace
// directory for the same repo (a workspace can outlive its worktree
// registration — archiving strips the `.git` link but keeps the directory).
export function discoverProjectRoots(primary: string): string[] {
  const roots = [path.resolve(primary)];
  const add = (p: string): void => {
    const r = path.resolve(p);
    if (!roots.includes(r)) roots.push(r);
  };

  try {
    const out = execSync("git worktree list --porcelain", {
      cwd: primary,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    for (const line of out.split("\n")) {
      if (line.startsWith("worktree ")) add(line.slice("worktree ".length).trim());
    }
  } catch {
    /* not a git repository */
  }

  const repoDir = path.join(conductorWorkspacesDir(), conductorRepoName(primary));
  if (fs.existsSync(repoDir)) {
    for (const entry of fs.readdirSync(repoDir, { withFileTypes: true })) {
      if (entry.isDirectory()) add(path.join(repoDir, entry.name));
    }
  }

  return roots;
}
