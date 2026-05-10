# Bookmark Manager API — Specification

A REST API for managing bookmarks with tags, collections, favorites, search,
archiving, click tracking, bulk operations, and analytics. Built with Bun + SQLite.

## Database Schema

### bookmarks
| Column | Type | Constraints |
|--------|------|-------------|
| id | INTEGER | PRIMARY KEY AUTOINCREMENT |
| url | TEXT | NOT NULL, UNIQUE |
| title | TEXT | NOT NULL DEFAULT '' |
| description | TEXT | NOT NULL DEFAULT '' |
| is_favorite | INTEGER | NOT NULL DEFAULT 0 |
| is_archived | INTEGER | NOT NULL DEFAULT 0 |
| click_count | INTEGER | NOT NULL DEFAULT 0 |
| last_clicked_at | TEXT | NULL |
| created_at | TEXT | NOT NULL |
| updated_at | TEXT | NOT NULL |

### tags
| Column | Type | Constraints |
|--------|------|-------------|
| id | INTEGER | PRIMARY KEY AUTOINCREMENT |
| name | TEXT | NOT NULL UNIQUE |

### bookmark_tags
| Column | Type | Constraints |
|--------|------|-------------|
| bookmark_id | INTEGER | NOT NULL, FK → bookmarks(id) ON DELETE CASCADE |
| tag_id | INTEGER | NOT NULL, FK → tags(id) ON DELETE CASCADE |
| | | PRIMARY KEY (bookmark_id, tag_id) |

### collections
| Column | Type | Constraints |
|--------|------|-------------|
| id | INTEGER | PRIMARY KEY AUTOINCREMENT |
| name | TEXT | NOT NULL UNIQUE |
| description | TEXT | NOT NULL DEFAULT '' |
| created_at | TEXT | NOT NULL |

### bookmark_collections
| Column | Type | Constraints |
|--------|------|-------------|
| bookmark_id | INTEGER | NOT NULL, FK → bookmarks(id) ON DELETE CASCADE |
| collection_id | INTEGER | NOT NULL, FK → collections(id) ON DELETE CASCADE |
| | | PRIMARY KEY (bookmark_id, collection_id) |

### notes
| Column | Type | Constraints |
|--------|------|-------------|
| id | INTEGER | PRIMARY KEY AUTOINCREMENT |
| bookmark_id | INTEGER | NOT NULL, FK → bookmarks(id) ON DELETE CASCADE |
| content | TEXT | NOT NULL |
| created_at | TEXT | NOT NULL |

Enable `PRAGMA foreign_keys = ON`.

Note: The initial schema (setup-schema task) only creates bookmarks, tags,
and bookmark_tags. Other tables are added by their respective tasks.

## Data Layer (src/bookmarks.ts)

### Types
```typescript
interface Bookmark {
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

interface ListResult {
  bookmarks: Bookmark[];
  total: number;
  page: number;
  limit: number;
}
```

### Functions
- `createBookmark({ url, title?, description? })` → Bookmark
  - Validate URL format (must start with http:// or https://)
  - Reject empty URL (throw Error)
  - Reject duplicate URLs (throw Error)
  - Default title to URL hostname if omitted
  - Set created_at/updated_at to ISO timestamps
- `getBookmark(id)` → Bookmark | null
- `listBookmarks(opts?)` → ListResult
  - opts.search: LIKE match on title, description, url (case-insensitive)
  - opts.tag: filter by tag name (JOIN bookmark_tags + tags)
  - opts.collection: filter by collection id
  - opts.favorites_only: WHERE is_favorite = 1
  - opts.include_archived: include archived bookmarks (default: false)
  - opts.page / opts.limit: LIMIT/OFFSET pagination (default page=1, limit=20, max 100)
  - opts.sort_by: created_at | title | url | updated_at | click_count (default: created_at)
  - opts.sort_order: asc | desc (default: desc)
- `updateBookmark(id, { title?, description?, url? })` → Bookmark | null
- `deleteBookmark(id)` → boolean
- `toggleFavorite(id)` → Bookmark | null
- `archiveBookmark(id)` → Bookmark | null
- `unarchiveBookmark(id)` → Bookmark | null
- `recordClick(id)` → Bookmark | null

## Data Layer (src/tags.ts)

- `addTag(bookmarkId, tagName)` → void (idempotent)
- `removeTag(bookmarkId, tagName)` → boolean
- `getBookmarkTags(bookmarkId)` → string[]
- `listTags()` → { name: string, count: number }[]

## Data Layer (src/collections.ts)

- `createCollection({ name, description? })` → Collection
- `getCollection(id)` → Collection | null
- `listCollections()` → Collection[]
- `deleteCollection(id)` → boolean
- `addToCollection(bookmarkId, collectionId)` → void
- `removeFromCollection(bookmarkId, collectionId)` → boolean
- `getCollectionBookmarks(collectionId, opts?)` → ListResult

## Data Layer (src/notes.ts)

- `addNote(bookmarkId, content)` → Note
- `getNotes(bookmarkId)` → Note[]
- `deleteNote(noteId)` → boolean

## REST Endpoints (src/server.ts)

Server runs on port 3457.

### Core
| Method | Path | Body | Response |
|--------|------|------|----------|
| GET | /health | — | `{ status: "ok" }` |

### Bookmarks
| Method | Path | Body | Response |
|--------|------|------|----------|
| POST | /bookmarks | `{ url, title?, description? }` | 201: Bookmark, 400/409 |
| GET | /bookmarks | ?q=&tag=&collection=&favorites=&archived=&page=&limit=&sort=&order= | ListResult |
| GET | /bookmarks/:id | — | 200: Bookmark, 404 |
| PATCH | /bookmarks/:id | `{ title?, description?, url? }` | 200: Bookmark, 404 |
| DELETE | /bookmarks/:id | — | 200: `{ deleted: true }`, 404 |

### Tags
| Method | Path | Body | Response |
|--------|------|------|----------|
| POST | /bookmarks/:id/tags | `{ tag: "name" }` | 200, 404 |
| DELETE | /bookmarks/:id/tags/:tag | — | 200: `{ deleted: true }` |
| GET | /bookmarks/:id/tags | — | 200: string[] |
| GET | /tags | — | 200: `{ name, count }[]` |

### Favorites & Archive
| Method | Path | Body | Response |
|--------|------|------|----------|
| POST | /bookmarks/:id/favorite | — | 200: Bookmark, 404 |
| POST | /bookmarks/:id/archive | — | 200: Bookmark, 404 |
| POST | /bookmarks/:id/unarchive | — | 200: Bookmark, 404 |

### Click tracking
| Method | Path | Body | Response |
|--------|------|------|----------|
| POST | /bookmarks/:id/click | — | 200: Bookmark, 404 |

### Collections
| Method | Path | Body | Response |
|--------|------|------|----------|
| POST | /collections | `{ name, description? }` | 201: Collection |
| GET | /collections | — | 200: Collection[] |
| GET | /collections/:id | — | 200: Collection, 404 |
| DELETE | /collections/:id | — | 200: `{ deleted: true }`, 404 |
| POST | /collections/:id/bookmarks | `{ bookmark_id }` | 200, 404 |
| DELETE | /collections/:id/bookmarks/:bookmarkId | — | 200 |
| GET | /collections/:id/bookmarks | ?page=&limit= | ListResult |

### Notes
| Method | Path | Body | Response |
|--------|------|------|----------|
| POST | /bookmarks/:id/notes | `{ content }` | 201: Note |
| GET | /bookmarks/:id/notes | — | 200: Note[] |
| DELETE | /notes/:id | — | 200: `{ deleted: true }`, 404 |

### Bulk operations
| Method | Path | Body | Response |
|--------|------|------|----------|
| POST | /bookmarks/import | `{ bookmarks: [{url, title?, tags?}] }` | 200: `{ imported, failed, errors }` |
| GET | /bookmarks/export | — | 200: `{ bookmarks: [{...bookmark, tags}] }` |

### Analytics
| Method | Path | Body | Response |
|--------|------|------|----------|
| GET | /stats | — | 200: stats object |

Stats response:
```json
{
  "total_bookmarks": 42,
  "total_archived": 5,
  "total_favorites": 12,
  "total_tags": 8,
  "total_collections": 3,
  "total_clicks": 156,
  "most_clicked": [{ "id": 1, "title": "...", "click_count": 50 }],
  "recent_bookmarks": [{ "id": 42, "title": "...", "created_at": "..." }],
  "top_tags": [{ "name": "javascript", "count": 15 }]
}
```

## Testing Conventions

- Use `bun:test` (import { test, expect, beforeEach } from "bun:test")
- Call `resetDb()` in `beforeEach` to clear state between tests
- Server tests import `"../src/server"` to start the server as side effect
- Server runs on `http://localhost:3457`
- Test files go in `test/` directory
- Each task creates its own test file
