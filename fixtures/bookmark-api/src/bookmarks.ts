import { getDb } from "./db";

export interface Bookmark {
  id: number;
  url: string;
  title: string;
  description: string;
  is_favorite: boolean;
  is_archived: boolean;
  click_count: number;
  last_clicked_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ListResult {
  bookmarks: Bookmark[];
  total: number;
  page: number;
  limit: number;
}

function rowToBookmark(row: any): Bookmark {
  return {
    id: row.id,
    url: row.url,
    title: row.title,
    description: row.description,
    is_favorite: row.is_favorite === 1,
    is_archived: row.is_archived === 1,
    click_count: row.click_count,
    last_clicked_at: row.last_clicked_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function validateUrl(url: string): void {
  if (!url || typeof url !== "string") {
    throw new Error("URL is required");
  }
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    throw new Error("URL must start with http:// or https://");
  }
}

export function createBookmark(opts: {
  url: string;
  title?: string;
  description?: string;
}): Bookmark {
  validateUrl(opts.url);

  const db = getDb();
  const now = new Date().toISOString();
  const title = opts.title || new URL(opts.url).hostname;
  const description = opts.description || "";

  try {
    const stmt = db.prepare(
      `INSERT INTO bookmarks (url, title, description, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`
    );
    const result = stmt.run(opts.url, title, description, now, now);
    const id = (result.lastInsertRowid as number) || 0;
    return getBookmark(id)!;
  } catch (e: any) {
    if (e.message && e.message.includes("UNIQUE")) {
      throw new Error("Duplicate URL");
    }
    throw e;
  }
}

export function getBookmark(id: number): Bookmark | null {
  const db = getDb();
  const stmt = db.prepare("SELECT * FROM bookmarks WHERE id = ?");
  const row = stmt.get(id);
  return row ? rowToBookmark(row) : null;
}

export function listBookmarks(opts?: {
  page?: number;
  limit?: number;
  tag?: string;
}): ListResult {
  const db = getDb();
  const page = opts?.page || 1;
  const limit = Math.min(opts?.limit || 20, 100);
  const offset = (page - 1) * limit;

  let countQuery = "SELECT COUNT(*) as count FROM bookmarks";
  let query =
    "SELECT * FROM bookmarks ORDER BY created_at DESC LIMIT ? OFFSET ?";

  if (opts?.tag) {
    countQuery = `
      SELECT COUNT(DISTINCT b.id) as count FROM bookmarks b
      INNER JOIN bookmark_tags bt ON b.id = bt.bookmark_id
      INNER JOIN tags t ON bt.tag_id = t.id
      WHERE t.name = ?
    `;
    query = `
      SELECT DISTINCT b.* FROM bookmarks b
      INNER JOIN bookmark_tags bt ON b.id = bt.bookmark_id
      INNER JOIN tags t ON bt.tag_id = t.id
      WHERE t.name = ?
      ORDER BY b.created_at DESC
      LIMIT ? OFFSET ?
    `;
  }

  const countStmt = db.prepare(countQuery);
  const countRow: any = opts?.tag
    ? countStmt.get(opts.tag)
    : countStmt.get();
  const total = countRow.count;

  const stmt = db.prepare(query);
  const rows: any[] = opts?.tag
    ? (stmt.all(opts.tag, limit, offset) as any[])
    : (stmt.all(limit, offset) as any[]);

  return {
    bookmarks: rows.map(rowToBookmark),
    total,
    page,
    limit,
  };
}

export function updateBookmark(
  id: number,
  opts: {
    title?: string;
    description?: string;
    url?: string;
  }
): Bookmark | null {
  const db = getDb();
  const current = getBookmark(id);
  if (!current) return null;

  if (opts.url) {
    validateUrl(opts.url);
  }

  const updates: string[] = [];
  const params: any[] = [];

  if (opts.title !== undefined) {
    updates.push("title = ?");
    params.push(opts.title);
  }
  if (opts.description !== undefined) {
    updates.push("description = ?");
    params.push(opts.description);
  }
  if (opts.url !== undefined) {
    updates.push("url = ?");
    params.push(opts.url);
  }

  updates.push("updated_at = ?");
  params.push(new Date().toISOString());
  params.push(id);

  try {
    const stmt = db.prepare(
      `UPDATE bookmarks SET ${updates.join(", ")} WHERE id = ?`
    );
    stmt.run(...params);
    return getBookmark(id);
  } catch (e: any) {
    if (e.message && e.message.includes("UNIQUE")) {
      throw new Error("Duplicate URL");
    }
    throw e;
  }
}

export function deleteBookmark(id: number): boolean {
  const db = getDb();
  const stmt = db.prepare("DELETE FROM bookmarks WHERE id = ?");
  const result = stmt.run(id);
  return (result.changes || 0) > 0;
}
