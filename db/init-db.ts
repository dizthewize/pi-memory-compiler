import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { mkdirSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));

function getDbPath(): string {
  const envPath = process.env.PI_MEMORY_DB_PATH;
  if (envPath) return envPath;
  const home = process.env.HOME || "/tmp";
  return join(home, ".pi-memory", "db", "memory.db");
}

export function initDatabase(dbPath?: string): Database.Database {
  const path = dbPath || getDbPath();
  mkdirSync(dirname(path), { recursive: true });

  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  sqliteVec.load(db);

  const schema = readFileSync(join(__dirname, "schema.sql"), "utf-8");
  db.exec(schema);

  // Insert default watermark if not exists
  db.prepare(`
    INSERT OR IGNORE INTO compilation_watermark (id, last_timestamp, run_count)
    VALUES (1, 0, 0)
  `).run();

  console.log(`Database initialized at: ${path}`);
  return db;
}

if (import.meta.url === process.argv[1] || process.argv[1]?.endsWith("init-db.ts")) {
  initDatabase();
}
