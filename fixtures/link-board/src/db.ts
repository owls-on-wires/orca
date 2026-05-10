import { Database } from "bun:sqlite";

export type User = {
  id: number;
  username: string;
  email: string;
  password_hash: string;
  bio: string | null;
  is_admin: number;
  is_banned: number;
  created_at: string;
};

export type Link = {
  id: number;
  title: string;
  url: string;
  user_id: number;
  created_at: string;
};

const isTest =
  process.env.NODE_ENV === "test" || process.env.BUN_ENV === "test";

export const db = new Database(isTest ? ":memory:" : "./data/link-board.db");

function createTables() {
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      bio TEXT DEFAULT NULL,
      is_admin INTEGER DEFAULT 0,
      is_banned INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      url TEXT NOT NULL,
      user_id INTEGER NOT NULL REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS votes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      link_id INTEGER NOT NULL REFERENCES links(id),
      direction INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, link_id)
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      body TEXT NOT NULL,
      user_id INTEGER NOT NULL REFERENCES users(id),
      link_id INTEGER NOT NULL REFERENCES links(id),
      parent_id INTEGER REFERENCES comments(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS comment_votes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      comment_id INTEGER NOT NULL REFERENCES comments(id),
      direction INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, comment_id)
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS flags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      target_type TEXT NOT NULL,
      target_id INTEGER NOT NULL,
      reason TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, target_type, target_id)
    )
  `);
}

createTables();

export function resetDb() {
  db.run("DROP TABLE IF EXISTS flags");
  db.run("DROP TABLE IF EXISTS comment_votes");
  db.run("DROP TABLE IF EXISTS comments");
  db.run("DROP TABLE IF EXISTS votes");
  db.run("DROP TABLE IF EXISTS links");
  db.run("DROP TABLE IF EXISTS users");
  createTables();
}

export function createUser(params: {
  username: string;
  email: string;
  passwordHash: string;
}): User {
  const count = (db.prepare("SELECT COUNT(*) AS count FROM users").get() as { count: number }).count;
  const isAdmin = count === 0 ? 1 : 0;
  const stmt = db.prepare(
    "INSERT INTO users (username, email, password_hash, is_admin) VALUES (?, ?, ?, ?) RETURNING *"
  );
  return stmt.get(params.username, params.email, params.passwordHash, isAdmin) as User;
}

export function getUserByEmail(email: string): User | null {
  return (
    (db.prepare("SELECT * FROM users WHERE email = ?").get(email) as
      | User
      | undefined) ?? null
  );
}

export function getUserById(id: number): User | null {
  return (
    (db.prepare("SELECT * FROM users WHERE id = ?").get(id) as
      | User
      | undefined) ?? null
  );
}

export function getUserByUsername(username: string): User | null {
  return (
    (db.prepare("SELECT * FROM users WHERE username = ?").get(username) as
      | User
      | undefined) ?? null
  );
}

export function createLink(params: {
  title: string;
  url: string;
  userId: number;
}): Link {
  return db
    .prepare(
      "INSERT INTO links (title, url, user_id) VALUES (?, ?, ?) RETURNING *"
    )
    .get(params.title, params.url, params.userId) as Link;
}

type LinkWithVotes = Link & {
  upvotes: number;
  downvotes: number;
  score: number;
  current_user_vote: number;
};

export function getLinks(params: {
  sort: "newest" | "top" | "controversial";
  limit: number;
  offset: number;
  userId?: number;
}): LinkWithVotes[] {
  const orderBy =
    params.sort === "top"
      ? "score DESC, l.id DESC"
      : params.sort === "controversial"
        ? "(upvotes + downvotes) DESC, ABS(score) ASC, l.id DESC"
        : "l.created_at DESC, l.id DESC";

  const uid = params.userId ?? 0;

  return db
    .prepare(
      `SELECT l.*,
        COALESCE(SUM(CASE WHEN v.direction = 1 THEN 1 ELSE 0 END), 0) AS upvotes,
        COALESCE(SUM(CASE WHEN v.direction = -1 THEN 1 ELSE 0 END), 0) AS downvotes,
        COALESCE(SUM(v.direction), 0) AS score,
        COALESCE((SELECT direction FROM votes WHERE user_id = ? AND link_id = l.id), 0) AS current_user_vote
      FROM links l
      LEFT JOIN votes v ON v.link_id = l.id
      GROUP BY l.id
      ORDER BY ${orderBy}
      LIMIT ? OFFSET ?`
    )
    .all(uid, params.limit, params.offset) as LinkWithVotes[];
}

export function getLinkById(
  id: number,
  userId?: number
): LinkWithVotes | null {
  const uid = userId ?? 0;
  return (
    (db
      .prepare(
        `SELECT l.*,
          COALESCE(SUM(CASE WHEN v.direction = 1 THEN 1 ELSE 0 END), 0) AS upvotes,
          COALESCE(SUM(CASE WHEN v.direction = -1 THEN 1 ELSE 0 END), 0) AS downvotes,
          COALESCE(SUM(v.direction), 0) AS score,
          COALESCE((SELECT direction FROM votes WHERE user_id = ? AND link_id = l.id), 0) AS current_user_vote
        FROM links l
        LEFT JOIN votes v ON v.link_id = l.id
        WHERE l.id = ?
        GROUP BY l.id`
      )
      .get(uid, id) as LinkWithVotes | undefined) ?? null
  );
}

export function voteOnLink(params: {
  userId: number;
  linkId: number;
  direction: 1 | -1;
}): void {
  db.prepare(
    "INSERT INTO votes (user_id, link_id, direction) VALUES (?, ?, ?) ON CONFLICT(user_id, link_id) DO UPDATE SET direction = excluded.direction"
  ).run(params.userId, params.linkId, params.direction);
}

export function countLinks(): number {
  return (db.prepare("SELECT COUNT(*) AS count FROM links").get() as { count: number }).count;
}

export function removeVote(params: {
  userId: number;
  linkId: number;
}): void {
  db.prepare("DELETE FROM votes WHERE user_id = ? AND link_id = ?").run(
    params.userId,
    params.linkId
  );
}

// --- Comments ---

export type Comment = {
  id: number;
  body: string;
  user_id: number;
  link_id: number;
  parent_id: number | null;
  created_at: string;
};

type CommentWithVotes = Comment & {
  username: string;
  upvotes: number;
  downvotes: number;
  score: number;
  current_user_vote: number;
  replies: CommentWithVotes[];
};

export function createComment(params: {
  body: string;
  userId: number;
  linkId: number;
  parentId?: number;
}): Comment {
  return db
    .prepare(
      "INSERT INTO comments (body, user_id, link_id, parent_id) VALUES (?, ?, ?, ?) RETURNING *"
    )
    .get(params.body, params.userId, params.linkId, params.parentId ?? null) as Comment;
}

export function getCommentsByLinkId(
  linkId: number,
  userId?: number
): CommentWithVotes[] {
  const uid = userId ?? 0;

  const rows = db
    .prepare(
      `SELECT c.*, u.username,
        COALESCE(SUM(CASE WHEN cv.direction = 1 THEN 1 ELSE 0 END), 0) AS upvotes,
        COALESCE(SUM(CASE WHEN cv.direction = -1 THEN 1 ELSE 0 END), 0) AS downvotes,
        COALESCE(SUM(cv.direction), 0) AS score,
        COALESCE((SELECT direction FROM comment_votes WHERE user_id = ? AND comment_id = c.id), 0) AS current_user_vote
      FROM comments c
      JOIN users u ON u.id = c.user_id
      LEFT JOIN comment_votes cv ON cv.comment_id = c.id
      WHERE c.link_id = ?
      GROUP BY c.id
      ORDER BY c.created_at ASC`
    )
    .all(uid, linkId) as (CommentWithVotes & { parent_id: number | null })[];

  // Build tree
  const byId = new Map<number, CommentWithVotes>();
  const roots: CommentWithVotes[] = [];

  for (const row of rows) {
    row.replies = [];
    byId.set(row.id, row);
  }

  for (const row of rows) {
    if (row.parent_id === null) {
      roots.push(row);
    } else {
      const parent = byId.get(row.parent_id);
      if (parent) parent.replies.push(row);
    }
  }

  return roots;
}

export function getCommentById(
  id: number,
  userId?: number
): CommentWithVotes | null {
  const uid = userId ?? 0;
  return (
    (db
      .prepare(
        `SELECT c.*, u.username,
          COALESCE(SUM(CASE WHEN cv.direction = 1 THEN 1 ELSE 0 END), 0) AS upvotes,
          COALESCE(SUM(CASE WHEN cv.direction = -1 THEN 1 ELSE 0 END), 0) AS downvotes,
          COALESCE(SUM(cv.direction), 0) AS score,
          COALESCE((SELECT direction FROM comment_votes WHERE user_id = ? AND comment_id = c.id), 0) AS current_user_vote
        FROM comments c
        JOIN users u ON u.id = c.user_id
        LEFT JOIN comment_votes cv ON cv.comment_id = c.id
        WHERE c.id = ?
        GROUP BY c.id`
      )
      .get(uid, id) as CommentWithVotes | undefined) ?? null
  );
}

export function voteOnComment(params: {
  userId: number;
  commentId: number;
  direction: 1 | -1;
}): void {
  db.prepare(
    "INSERT INTO comment_votes (user_id, comment_id, direction) VALUES (?, ?, ?) ON CONFLICT(user_id, comment_id) DO UPDATE SET direction = excluded.direction"
  ).run(params.userId, params.commentId, params.direction);
}

export function removeCommentVote(params: {
  userId: number;
  commentId: number;
}): void {
  db.prepare(
    "DELETE FROM comment_votes WHERE user_id = ? AND comment_id = ?"
  ).run(params.userId, params.commentId);
}

export function softDeleteComment(id: number): Comment {
  return db
    .prepare("UPDATE comments SET body = '[deleted]' WHERE id = ? RETURNING *")
    .get(id) as Comment;
}

// --- Profiles ---

export type UserProfile = {
  username: string;
  karma: number;
  created_at: string;
  link_count: number;
  comment_count: number;
  bio: string | null;
};

export function getUserProfile(username: string): UserProfile | null {
  const user = getUserByUsername(username);
  if (!user) return null;

  const row = db
    .prepare(
      `SELECT
        (COALESCE((SELECT SUM(v.direction) FROM votes v JOIN links l ON l.id = v.link_id WHERE l.user_id = ?), 0)
         + COALESCE((SELECT SUM(cv.direction) FROM comment_votes cv JOIN comments c ON c.id = cv.comment_id WHERE c.user_id = ?), 0)) AS karma,
        (SELECT COUNT(*) FROM links WHERE user_id = ?) AS link_count,
        (SELECT COUNT(*) FROM comments WHERE user_id = ?) AS comment_count`
    )
    .get(user.id, user.id, user.id, user.id) as {
    karma: number;
    link_count: number;
    comment_count: number;
  };

  return {
    username: user.username,
    karma: row.karma,
    created_at: user.created_at,
    link_count: row.link_count,
    comment_count: row.comment_count,
    bio: user.bio,
  };
}

export function getUserLinks(
  username: string,
  limit: number,
  offset: number
): { id: number; title: string; url: string; score: number; created_at: string }[] {
  return db
    .prepare(
      `SELECT l.id, l.title, l.url, COALESCE(SUM(v.direction), 0) AS score, l.created_at
       FROM links l
       JOIN users u ON u.id = l.user_id
       LEFT JOIN votes v ON v.link_id = l.id
       WHERE u.username = ?
       GROUP BY l.id
       ORDER BY l.created_at DESC
       LIMIT ? OFFSET ?`
    )
    .all(username, limit, offset) as {
    id: number;
    title: string;
    url: string;
    score: number;
    created_at: string;
  }[];
}

export function getUserComments(
  username: string,
  limit: number,
  offset: number
): { id: number; body: string; link_id: number; score: number; created_at: string }[] {
  return db
    .prepare(
      `SELECT c.id, c.body, c.link_id, COALESCE(SUM(cv.direction), 0) AS score, c.created_at
       FROM comments c
       JOIN users u ON u.id = c.user_id
       LEFT JOIN comment_votes cv ON cv.comment_id = c.id
       WHERE u.username = ?
       GROUP BY c.id
       ORDER BY c.created_at DESC
       LIMIT ? OFFSET ?`
    )
    .all(username, limit, offset) as {
    id: number;
    body: string;
    link_id: number;
    score: number;
    created_at: string;
  }[];
}

export function updateUserBio(username: string, bio: string): void {
  db.prepare("UPDATE users SET bio = ? WHERE id = (SELECT id FROM users WHERE username = ?)").run(bio, username);
}

// --- Moderation ---

export type Flag = {
  id: number;
  user_id: number;
  target_type: string;
  target_id: number;
  reason: string | null;
  created_at: string;
};

export function flagContent(params: {
  userId: number;
  targetType: string;
  targetId: number;
  reason?: string;
}): Flag {
  return db
    .prepare(
      "INSERT INTO flags (user_id, target_type, target_id, reason) VALUES (?, ?, ?, ?) RETURNING *"
    )
    .get(params.userId, params.targetType, params.targetId, params.reason ?? null) as Flag;
}

export function getFlaggedContent(): (Flag & { title?: string; url?: string; body?: string })[] {
  const flags = db
    .prepare("SELECT * FROM flags ORDER BY id DESC")
    .all() as Flag[];

  return flags.map((flag) => {
    if (flag.target_type === "link") {
      const link = db.prepare("SELECT title, url FROM links WHERE id = ?").get(flag.target_id) as { title: string; url: string } | undefined;
      return { ...flag, title: link?.title, url: link?.url };
    } else if (flag.target_type === "comment") {
      const comment = db.prepare("SELECT body FROM comments WHERE id = ?").get(flag.target_id) as { body: string } | undefined;
      return { ...flag, body: comment?.body };
    }
    return flag;
  });
}

export function setUserBanned(userId: number, banned: boolean): void {
  db.prepare("UPDATE users SET is_banned = ? WHERE id = ?").run(banned ? 1 : 0, userId);
}

export function isUserBanned(userId: number): boolean {
  const row = db.prepare("SELECT is_banned FROM users WHERE id = ?").get(userId) as { is_banned: number } | undefined;
  return row?.is_banned === 1;
}

export function adminDeleteLink(linkId: number): void {
  db.prepare("DELETE FROM comment_votes WHERE comment_id IN (SELECT id FROM comments WHERE link_id = ?)").run(linkId);
  db.prepare("DELETE FROM votes WHERE link_id = ?").run(linkId);
  db.prepare("DELETE FROM comments WHERE link_id = ?").run(linkId);
  db.prepare("DELETE FROM links WHERE id = ?").run(linkId);
}

export function adminDeleteComment(commentId: number): void {
  db.prepare("DELETE FROM comment_votes WHERE comment_id = ?").run(commentId);
  db.prepare("DELETE FROM comments WHERE id = ?").run(commentId);
}

export function searchContent(
  query: string,
  limit: number,
  offset: number
): { type: string; id: number; title?: string; url?: string; body?: string; link_id?: number; score: number; created_at: string }[] {
  const pattern = `%${query}%`;

  const results = db
    .prepare(
      `SELECT * FROM (
        SELECT 'link' AS type, l.id, l.title, l.url, NULL AS body, NULL AS link_id,
               COALESCE(SUM(v.direction), 0) AS score, l.created_at
        FROM links l
        LEFT JOIN votes v ON v.link_id = l.id
        WHERE l.title LIKE ? OR l.url LIKE ?
        GROUP BY l.id
        UNION ALL
        SELECT 'comment' AS type, c.id, NULL AS title, NULL AS url, c.body, c.link_id,
               COALESCE(SUM(cv.direction), 0) AS score, c.created_at
        FROM comments c
        LEFT JOIN comment_votes cv ON cv.comment_id = c.id
        WHERE c.body LIKE ?
        GROUP BY c.id
       ) ORDER BY created_at DESC
       LIMIT ? OFFSET ?`
    )
    .all(pattern, pattern, pattern, limit, offset) as { type: string; id: number; title?: string; url?: string; body?: string; link_id?: number; score: number; created_at: string }[];

  return results;
}

export function countSearchContent(query: string): number {
  const pattern = `%${query}%`;
  const row = db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM links WHERE title LIKE ? OR url LIKE ?)
            + (SELECT COUNT(*) FROM comments WHERE body LIKE ?) AS total`
    )
    .get(pattern, pattern, pattern) as { total: number };
  return row.total;
}
