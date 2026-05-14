import {
  createBookmark,
  getBookmark,
  listBookmarks,
  updateBookmark,
  deleteBookmark,
} from "./bookmarks";
import {
  addTag,
  removeTag,
  getBookmarkTags,
  listTags,
} from "./tags";

const server = Bun.serve({
  port: 3457,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/health" && req.method === "GET") {
      return Response.json({ status: "ok" });
    }

    // POST /bookmarks
    if (path === "/bookmarks" && req.method === "POST") {
      let body: Record<string, unknown>;
      try {
        body = await req.json();
      } catch {
        return Response.json({ error: "Invalid JSON" }, { status: 400 });
      }
      try {
        const bookmark = createBookmark({
          url: body.url as string,
          title: body.title as string | undefined,
          description: body.description as string | undefined,
        });
        return Response.json(bookmark, { status: 201 });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : "Error";
        return Response.json({ error: msg }, { status: 400 });
      }
    }

    // GET /bookmarks
    if (path === "/bookmarks" && req.method === "GET") {
      const opts = {
        page: url.searchParams.get("page")
          ? Number(url.searchParams.get("page"))
          : undefined,
        limit: url.searchParams.get("limit")
          ? Number(url.searchParams.get("limit"))
          : undefined,
        tag: url.searchParams.get("tag") || undefined,
      };
      return Response.json(listBookmarks(opts));
    }

    // GET /bookmarks/:id, PATCH /bookmarks/:id, DELETE /bookmarks/:id
    const singleMatch = path.match(/^\/bookmarks\/(\d+)$/);
    if (singleMatch) {
      const id = Number(singleMatch[1]);

      if (req.method === "GET") {
        const bookmark = getBookmark(id);
        if (!bookmark)
          return Response.json({ error: "Not found" }, { status: 404 });
        return Response.json(bookmark);
      }

      if (req.method === "PATCH") {
        let body: Record<string, unknown>;
        try {
          body = await req.json();
        } catch {
          return Response.json({ error: "Invalid JSON" }, { status: 400 });
        }
        try {
          const bookmark = updateBookmark(id, {
            title: body.title as string | undefined,
            description: body.description as string | undefined,
            url: body.url as string | undefined,
          });
          if (!bookmark)
            return Response.json({ error: "Not found" }, { status: 404 });
          return Response.json(bookmark);
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : "Error";
          return Response.json({ error: msg }, { status: 400 });
        }
      }

      if (req.method === "DELETE") {
        const deleted = deleteBookmark(id);
        if (!deleted)
          return Response.json({ error: "Not found" }, { status: 404 });
        return Response.json({ deleted: true });
      }
    }

    // GET /tags
    if (path === "/tags" && req.method === "GET") {
      return Response.json(listTags());
    }

    // POST /bookmarks/:id/tags, DELETE /bookmarks/:id/tags/:tag, GET /bookmarks/:id/tags
    const tagsMatch = path.match(/^\/bookmarks\/(\d+)\/tags(?:\/(.+))?$/);
    if (tagsMatch) {
      const bookmarkId = Number(tagsMatch[1]);
      const tagName = tagsMatch[2];

      if (req.method === "POST") {
        let body: Record<string, unknown>;
        try {
          body = await req.json();
        } catch {
          return Response.json({ error: "Invalid JSON" }, { status: 400 });
        }
        try {
          const tag = body.tag as string;
          if (!tag) {
            return Response.json(
              { error: "Tag name required" },
              { status: 400 }
            );
          }
          addTag(bookmarkId, tag);
          return Response.json({
            bookmark_id: bookmarkId,
            tag: tag,
          });
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : "Error";
          return Response.json({ error: msg }, { status: 404 });
        }
      }

      if (req.method === "GET" && !tagName) {
        // GET /bookmarks/:id/tags
        try {
          const tags = getBookmarkTags(bookmarkId);
          return Response.json(tags);
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : "Error";
          return Response.json({ error: msg }, { status: 404 });
        }
      }

      if (req.method === "DELETE" && tagName) {
        // DELETE /bookmarks/:id/tags/:tag
        const deleted = removeTag(bookmarkId, tagName);
        return Response.json({ deleted });
      }
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  },
});

console.log(`Bookmark API running on port ${server.port}`);
