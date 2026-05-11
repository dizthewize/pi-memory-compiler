import Database from "better-sqlite3";
import { initDatabase } from "./init-db.js";

let dbInstance: Database.Database | null = null;
let dbOverride: Database.Database | null = null;

export function getDb(): Database.Database {
  if (dbOverride) return dbOverride;
  if (!dbInstance) {
    dbInstance = initDatabase();
  }
  return dbInstance;
}

export function setDbOverride(db: Database.Database | null): void {
  dbOverride = db;
}

export function closeDb(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
  dbOverride = null;
}

export function resetDb(): Database.Database {
  closeDb();
  return getDb();
}
