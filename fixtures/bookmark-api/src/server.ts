const server = Bun.serve({
  port: 3457,
  fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/health" && req.method === "GET") {
      return Response.json({ status: "ok" });
    }

    // TODO: Add bookmark, tag, search, favorites, and pagination endpoints

    return Response.json({ error: "Not found" }, { status: 404 });
  },
});

console.log(`Bookmark API running on port ${server.port}`);
