const server = Bun.serve({
  port: Number(process.env.PORT ?? 37003),
  fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/health" && req.method === "GET") {
      return Response.json({ status: "ok" });
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  },
});

console.log(`Link Board API running on port ${server.port}`);
