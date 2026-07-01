// Minimal bootable scaffold for the Todo API.
// It starts and answers a health check — no features are implemented yet.
// Build the product described in PROMPT.md on top of this entry point.

const port = Number(process.env.PORT) || 37001;

const server = Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/health") {
      return Response.json({ status: "ok" });
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  },
});

console.log(`Todo API listening on http://localhost:${server.port}`);
