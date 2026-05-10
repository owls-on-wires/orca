import { listTodos, getTodo, createTodo, updateTodo, deleteTodo } from "./todos";

const server = Bun.serve({
  port: 3456,
  async fetch(req) {
    const url = new URL(req.url);
    const method = req.method;

    // GET /todos
    if (method === "GET" && url.pathname === "/todos") {
      const completedParam = url.searchParams.get("completed");
      const searchParam = url.searchParams.get("q");
      const pageParam = url.searchParams.get("page");
      const limitParam = url.searchParams.get("limit");
      const filter: { completed?: boolean; search?: string } = {};
      if (completedParam !== null) filter.completed = completedParam === "true";
      if (searchParam !== null) filter.search = searchParam;
      const pagination: { page?: number; limit?: number } = {};
      if (pageParam !== null) pagination.page = parseInt(pageParam);
      if (limitParam !== null) pagination.limit = parseInt(limitParam);
      return Response.json(listTodos(
        Object.keys(filter).length > 0 ? filter : undefined,
        Object.keys(pagination).length > 0 ? pagination : undefined
      ));
    }

    // GET /todos/:id
    const getMatch = url.pathname.match(/^\/todos\/(\d+)$/);
    if (method === "GET" && getMatch) {
      const todo = getTodo(parseInt(getMatch[1]));
      if (!todo) return Response.json({ error: "Not found" }, { status: 404 });
      return Response.json(todo);
    }

    // POST /todos
    if (method === "POST" && url.pathname === "/todos") {
      const body = await req.json();
      const { title } = body;
      if (!title) return Response.json({ error: "Title is required" }, { status: 400 });
      const todo = createTodo(title);
      return Response.json(todo, { status: 201 });
    }

    // PATCH /todos/:id
    const idMatch = url.pathname.match(/^\/todos\/(\d+)$/);
    if (method === "PATCH" && idMatch) {
      const body = await req.json();
      const todo = updateTodo(parseInt(idMatch[1]), body);
      if (!todo) return Response.json({ error: "Not found" }, { status: 404 });
      return Response.json(todo);
    }

    // DELETE /todos/:id
    if (method === "DELETE" && idMatch) {
      const deleted = deleteTodo(parseInt(idMatch[1]));
      if (!deleted) return Response.json({ error: "Not found" }, { status: 404 });
      return Response.json({ deleted: true });
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  },
});

console.log(`Todo API listening on http://localhost:${server.port}`);
