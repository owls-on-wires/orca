import { Database } from "bun:sqlite";

let db: Database;

export function getDb(): Database {
  if (!db) {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE IF NOT EXISTS todos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        completed INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
  }
  return db;
}

export function resetDb(): void {
  if (db) db.close();
  db = undefined as any;
}
