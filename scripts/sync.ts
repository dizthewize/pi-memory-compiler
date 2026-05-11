#!/usr/bin/env tsx
/**
 * Sync: Pull remote changes before work, push local changes after.
 * For cross-device sync via git (e.g., Obsidian vault on multiple machines).
 *
 * Usage:
 *   tsx scripts/sync.ts pull    # Pull latest before starting Pi
 *   tsx scripts/sync.ts push    # Push current changes
 *   tsx scripts/sync.ts status  # Show git status
 */
import { loadConfig } from "../src/config.js";
import { gitPull, gitPush, gitIsClean } from "../src/git.js";

const command = process.argv[2] || "status";
const config = loadConfig();
const cwd = config.vaultPath;

if (!config.git?.enabled) {
  console.log("Git sync is disabled in config.");
  process.exit(0);
}

async function main() {
  switch (command) {
    case "pull": {
      console.log(`Pulling latest into ${cwd}...`);
      const result = gitPull(cwd);
      if (result.ok) {
        console.log("✅ Pulled latest changes");
        if (result.output) console.log(result.output);
      } else {
        console.error("❌ Pull failed:", result.error);
        process.exit(1);
      }
      break;
    }

    case "push": {
      console.log(`Pushing from ${cwd}...`);
      const result = gitPush(cwd);
      if (result.ok) {
        console.log("✅ Pushed to remote");
        if (result.output) console.log(result.output);
      } else {
        console.error("❌ Push failed:", result.error);
        process.exit(1);
      }
      break;
    }

    case "status": {
      const clean = gitIsClean(cwd);
      console.log(clean ? "✅ Working tree clean" : "📝 Uncommitted changes present");
      break;
    }

    default: {
      console.log(`Unknown command: ${command}`);
      console.log("Usage: tsx scripts/sync.ts [pull|push|status]");
      process.exit(1);
    }
  }
}

main();
