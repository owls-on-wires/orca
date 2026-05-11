import { Database } from "bun:sqlite";

const db = new Database("link-board.db");

function initSchema() {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    is_admin INTEGER DEFAULT 0,
    bio TEXT,
    is_banned INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
}

initSchema();

export function resetDb() {
  db.run("DROP TABLE IF EXISTS users");
  initSchema();
}

export function createUser({ username, email, passwordHash }: { username: string; email: string; passwordHash: string }) {
  const count = (db.query("SELECT COUNT(*) as n FROM users").get() as { n: number }).n;
  const isAdmin = count === 0 ? 1 : 0;
  db.run(
    "INSERT INTO users (username, email, password_hash, is_admin) VALUES (?, ?, ?, ?)",
    [username, email, passwordHash, isAdmin]
  );
  return db.query("SELECT * FROM users WHERE email = ?").get(email) as {
    id: number;
    username: string;
    email: string;
    password_hash: string;
    is_admin: number;
    bio: string | null;
    is_banned: number;
    created_at: string;
  };
}

export function getUserByEmail(email: string) {
  return db.query("SELECT * FROM users WHERE email = ?").get(email) as {
    id: number;
    username: string;
    email: string;
    password_hash: string;
    is_admin: number;
    bio: string | null;
    is_banned: number;
    created_at: string;
  } | null;
}

export function getUserById(id: number) {
  return db.query("SELECT * FROM users WHERE id = ?").get(id) as {
    id: number;
    username: string;
    email: string;
    password_hash: string;
    is_admin: number;
    bio: string | null;
    is_banned: number;
    created_at: string;
  } | null;
}

export function getUserByUsername(username: string) {
  return db.query("SELECT * FROM users WHERE username = ?").get(username) as {
    id: number;
    username: string;
    email: string;
    password_hash: string;
    is_admin: number;
    bio: string | null;
    is_banned: number;
    created_at: string;
  } | null;
}

// --- Stubs ---

export function createLink(..._args: any[]): any { throw new Error("not implemented"); }
export function getLinks(..._args: any[]): any { throw new Error("not implemented"); }
export function getLinkById(..._args: any[]): any { throw new Error("not implemented"); }
export function countLinks(..._args: any[]): any { throw new Error("not implemented"); }
export function voteOnLink(..._args: any[]): any { throw new Error("not implemented"); }
export function removeVote(..._args: any[]): any { throw new Error("not implemented"); }
export function createComment(..._args: any[]): any { throw new Error("not implemented"); }
export function getCommentsByLinkId(..._args: any[]): any { throw new Error("not implemented"); }
export function getCommentById(..._args: any[]): any { throw new Error("not implemented"); }
export function voteOnComment(..._args: any[]): any { throw new Error("not implemented"); }
export function removeCommentVote(..._args: any[]): any { throw new Error("not implemented"); }
export function softDeleteComment(..._args: any[]): any { throw new Error("not implemented"); }
export function getUserProfile(..._args: any[]): any { throw new Error("not implemented"); }
export function getUserLinks(..._args: any[]): any { throw new Error("not implemented"); }
export function getUserComments(..._args: any[]): any { throw new Error("not implemented"); }
export function updateUserBio(..._args: any[]): any { throw new Error("not implemented"); }
export function searchContent(..._args: any[]): any { throw new Error("not implemented"); }
export function countSearchContent(..._args: any[]): any { throw new Error("not implemented"); }
export function flagContent(..._args: any[]): any { throw new Error("not implemented"); }
export function getFlaggedContent(..._args: any[]): any { throw new Error("not implemented"); }
export function setUserBanned(..._args: any[]): any { throw new Error("not implemented"); }
export function isUserBanned(..._args: any[]): any { throw new Error("not implemented"); }
export function adminDeleteLink(..._args: any[]): any { throw new Error("not implemented"); }
export function adminDeleteComment(..._args: any[]): any { throw new Error("not implemented"); }
