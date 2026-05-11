import { execSync, spawn } from "child_process";
import { existsSync } from "fs";
import { join } from "path";

export interface GitResult {
  ok: boolean;
  output: string;
  error?: string;
}

function runGit(cwd: string, args: string[]): GitResult {
  try {
    const output = execSync(`git ${args.join(" ")}`, {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { ok: true, output: output.trim() };
  } catch (err: any) {
    return { ok: false, output: "", error: err.stderr?.toString() || err.message };
  }
}

function hasGitRepo(cwd: string): boolean {
  return existsSync(join(cwd, ".git"));
}

/**
 * Stage all changes, commit with message, and push to remote.
 */
export function gitPush(cwd: string, message?: string): GitResult {
  if (!hasGitRepo(cwd)) {
    return { ok: false, output: "", error: "No git repository found" };
  }

  // Check if there are changes
  const status = runGit(cwd, ["status", "--porcelain"]);
  if (!status.ok) return status;
  if (!status.output.trim()) {
    return { ok: true, output: "Nothing to commit" };
  }

  const commitMsg = message || `pi-memory: auto-sync ${new Date().toISOString().slice(0, 16)}`;

  const add = runGit(cwd, ["add", "-A"]);
  if (!add.ok) return add;

  const commit = runGit(cwd, ["commit", "-m", commitMsg]);
  if (!commit.ok && !commit.error?.includes("nothing to commit")) {
    return commit;
  }

  const push = runGit(cwd, ["push"]);
  return push;
}

/**
 * Pull latest changes from remote.
 */
export function gitPull(cwd: string): GitResult {
  if (!hasGitRepo(cwd)) {
    return { ok: false, output: "", error: "No git repository found" };
  }
  return runGit(cwd, ["pull", "--ff-only"]);
}

/**
 * Check git status — returns true if working tree is clean.
 */
export function gitIsClean(cwd: string): boolean {
  if (!hasGitRepo(cwd)) return true;
  const status = runGit(cwd, ["status", "--porcelain"]);
  return status.ok && !status.output.trim();
}

/**
 * Background git push (non-blocking).
 */
export function gitPushBackground(cwd: string, message?: string): void {
  if (!hasGitRepo(cwd)) return;

  const commitMsg = message || `pi-memory: auto-sync ${new Date().toISOString().slice(0, 16)}`;
  const child = spawn("git", ["add", "-A"], { cwd, detached: true, stdio: "ignore" });

  child.on("exit", (code) => {
    if (code !== 0) return;
    const commit = spawn("git", ["commit", "-m", commitMsg], { cwd, detached: true, stdio: "ignore" });
    commit.on("exit", (c2) => {
      if (c2 !== 0) return;
      spawn("git", ["push"], { cwd, detached: true, stdio: "ignore" }).unref();
    });
  });

  child.unref();
}
