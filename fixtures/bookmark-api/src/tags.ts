import { getDb } from "./db";

export interface TagInfo {
  name: string;
  count: number;
}

/**
 * Add a tag to a bookmark (idempotent - no duplicates)
 */
export function addTag(bookmarkId: number, tagName: string): void {
  const db = getDb();

  // Verify bookmark exists
  const bookmarkCheck = db.prepare("SELECT id FROM bookmarks WHERE id = ?");
  if (!bookmarkCheck.get(bookmarkId)) {
    throw new Error("Bookmark not found");
  }

  // Get or create tag
  let tagId: number;
  const tagCheck = db.prepare("SELECT id FROM tags WHERE name = ?");
  const existingTag = tagCheck.get(tagName) as any;

  if (existingTag) {
    tagId = existingTag.id;
  } else {
    const insertTag = db.prepare("INSERT INTO tags (name) VALUES (?)");
    const result = insertTag.run(tagName);
    tagId = (result.lastInsertRowid as number) || 0;
  }

  // Add bookmark-tag association (idempotent - ignore if already exists)
  try {
    const insertBookmarkTag = db.prepare(
      "INSERT INTO bookmark_tags (bookmark_id, tag_id) VALUES (?, ?)"
    );
    insertBookmarkTag.run(bookmarkId, tagId);
  } catch (e: any) {
    // If UNIQUE constraint violation, the tag is already associated - that's fine (idempotent)
    if (!e.message || !e.message.includes("UNIQUE")) {
      throw e;
    }
  }
}

/**
 * Remove a tag from a bookmark
 */
export function removeTag(bookmarkId: number, tagName: string): boolean {
  const db = getDb();

  // Get tag id
  const tagCheck = db.prepare("SELECT id FROM tags WHERE name = ?");
  const tag = tagCheck.get(tagName) as any;

  if (!tag) {
    return false;
  }

  // Remove association
  const deleteStmt = db.prepare(
    "DELETE FROM bookmark_tags WHERE bookmark_id = ? AND tag_id = ?"
  );
  const result = deleteStmt.run(bookmarkId, tag.id);
  return (result.changes || 0) > 0;
}

/**
 * Get all tags for a bookmark
 */
export function getBookmarkTags(bookmarkId: number): string[] {
  const db = getDb();

  const stmt = db.prepare(`
    SELECT t.name FROM tags t
    INNER JOIN bookmark_tags bt ON t.id = bt.tag_id
    WHERE bt.bookmark_id = ?
    ORDER BY t.name ASC
  `);

  const rows = stmt.all(bookmarkId) as any[];
  return rows.map((row) => row.name);
}

/**
 * Get all tags with their counts
 */
export function listTags(): TagInfo[] {
  const db = getDb();

  const stmt = db.prepare(`
    SELECT t.name, COUNT(bt.bookmark_id) as count FROM tags t
    LEFT JOIN bookmark_tags bt ON t.id = bt.tag_id
    GROUP BY t.id, t.name
    ORDER BY t.name ASC
  `);

  const rows = stmt.all() as any[];
  return rows.map((row) => ({
    name: row.name,
    count: row.count || 0,
  }));
}
