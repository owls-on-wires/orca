// Minimal bootable scaffold. It starts and answers a health check.
// No product features are implemented yet — that is the build's job.

const port = Number(process.env.PORT) || 37002;

const server = Bun.serve({
  port,
  fetch(req) {
    const { pathname } = new URL(req.url);

    if (pathname === "/health" && req.method === "GET") {
      return Response.json({ status: "ok" });
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  },
});

console.log(`bookmark-api listening on port ${server.port}`);
