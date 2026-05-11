import { spawn } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { existsSync, mkdirSync, appendFileSync, createWriteStream } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");

// Try to find the tsx loader
function resolveTsx(): string | undefined {
  const candidates = [
    join(projectRoot, "node_modules", "tsx", "dist", "loader.mjs"),
    join(projectRoot, "node_modules", "tsx", "dist", "register.mjs"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return undefined;
}

function getLogFile(): string {
  return join(projectRoot, "logs", "background.log");
}

function logError(msg: string): void {
  const logFile = getLogFile();
  mkdirSync(dirname(logFile), { recursive: true });
  appendFileSync(logFile, `[${new Date().toISOString()}] ${msg}\n`);
}

/**
 * Spawn a background Node process to run a script.
 * Detached so the parent can exit without waiting.
 */
export function runBackground(script: string, args: string[] = []): void {
  const tsxLoader = resolveTsx();
  const logFile = getLogFile();
  const scriptPath = join(projectRoot, script);

  const nodeArgs: string[] = [];
  if (tsxLoader) {
    nodeArgs.push("--import", tsxLoader);
  }
  nodeArgs.push(scriptPath, ...args);

  const child = spawn(process.execPath, nodeArgs, {
    detached: true,
    stdio: ["ignore", "ignore", "pipe"],
    cwd: projectRoot,
    env: { ...process.env, PI_MEMORY_BACKGROUND: "1" },
  });

  // Capture stderr to log file for debugging
  if (child.stderr) {
    mkdirSync(dirname(logFile), { recursive: true });
    const log = createWriteStream(logFile, { flags: "a" });
    child.stderr.pipe(log);
    child.stderr.on("end", () => log.end());
  }

  child.on("error", (err) => {
    logError(`ERROR spawning ${script}: ${err.message}`);
  });

  child.on("exit", (code) => {
    if (code !== 0 && code !== null) {
      logError(`EXIT ${script}: code ${code}`);
    }
  });

  child.unref();
}

/**
 * Trigger a background flush of uncompiled sessions.
 */
export function triggerFlush(): void {
  runBackground("scripts/flush.ts");
}

/**
 * Trigger a background compilation (dream phase).
 */
export function triggerCompile(limit?: number): void {
  runBackground("scripts/compile.ts", limit ? [String(limit)] : []);
}
