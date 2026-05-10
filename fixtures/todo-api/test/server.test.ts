import { expect, test, beforeAll, beforeEach, afterAll } from "bun:test";
import { resetDb } from "../src/db";
import { listTodos, getTodo, createTodo, updateTodo, deleteTodo } from "../src/todos";

const BASE = "http://localhost:3456";
let server: any;

beforeAll(() => {
  server = Bun.serve({
    port: 3456,
    async fetch(req) {
      const url = new URL(req.url);
      const method = req.method;

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

      const idMatch = url.pathname.match(/^\/todos\/(\d+)$/);

      if (method === "GET" && idMatch) {
        const todo = getTodo(parseInt(idMatch[1]));
        if (!todo) return Response.json({ error: "Not found" }, { status: 404 });
        return Response.json(todo);
      }

      if (method === "POST" && url.pathname === "/todos") {
        const body = await req.json();
        const { title } = body;
        if (!title) return Response.json({ error: "Title is required" }, { status: 400 });
        const todo = createTodo(title);
        return Response.json(todo, { status: 201 });
      }

      if (method === "PATCH" && idMatch) {
        const body = await req.json();
        const todo = updateTodo(parseInt(idMatch[1]), body);
        if (!todo) return Response.json({ error: "Not found" }, { status: 404 });
        return Response.json(todo);
      }

      if (method === "DELETE" && idMatch) {
        const deleted = deleteTodo(parseInt(idMatch[1]));
        if (!deleted) return Response.json({ error: "Not found" }, { status: 404 });
        return Response.json({ deleted: true });
      }

      return Response.json({ error: "Not found" }, { status: 404 });
    },
  });
});

beforeEach(async () => {
  resetDb();
});

test("GET /todos returns empty array", async () => {
  const res = await fetch(`${BASE}/todos`);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.todos).toEqual([]);
});

test("POST /todos creates a todo", async () => {
  const res = await fetch(`${BASE}/todos`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "New todo" }),
  });
  expect(res.status).toBe(201);
  const todo = await res.json();
  expect(todo.title).toBe("New todo");
  expect(todo.completed).toBe(false);
});

test("POST /todos rejects empty title", async () => {
  const res = await fetch(`${BASE}/todos`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "" }),
  });
  expect(res.status).toBe(400);
});

test("GET /todos/:id returns a todo", async () => {
  const createRes = await fetch(`${BASE}/todos`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Fetch me" }),
  });
  const created = await createRes.json();

  const res = await fetch(`${BASE}/todos/${created.id}`);
  expect(res.status).toBe(200);
  const todo = await res.json();
  expect(todo.title).toBe("Fetch me");
});

test("GET /todos/:id returns 404 for missing", async () => {
  const res = await fetch(`${BASE}/todos/999`);
  expect(res.status).toBe(404);
});

test("PATCH /todos/:id updates title", async () => {
  const createRes = await fetch(`${BASE}/todos`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Old" }),
  });
  const created = await createRes.json();

  const res = await fetch(`${BASE}/todos/${created.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "New" }),
  });
  expect(res.status).toBe(200);
  const updated = await res.json();
  expect(updated.title).toBe("New");
});

test("PATCH /todos/:id toggles completed", async () => {
  const createRes = await fetch(`${BASE}/todos`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Toggle me" }),
  });
  const created = await createRes.json();

  const res = await fetch(`${BASE}/todos/${created.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ completed: true }),
  });
  expect(res.status).toBe(200);
  const updated = await res.json();
  expect(updated.completed).toBe(true);
});

test("DELETE /todos/:id removes a todo", async () => {
  const createRes = await fetch(`${BASE}/todos`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Delete me" }),
  });
  const created = await createRes.json();

  const res = await fetch(`${BASE}/todos/${created.id}`, { method: "DELETE" });
  expect(res.status).toBe(200);

  const getRes = await fetch(`${BASE}/todos/${created.id}`);
  expect(getRes.status).toBe(404);
});

test("DELETE /todos/:id returns 404 for missing", async () => {
  const res = await fetch(`${BASE}/todos/999`, { method: "DELETE" });
  expect(res.status).toBe(404);
});

test("GET /todos?completed=true returns only completed todos", async () => {
  await fetch(`${BASE}/todos`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Done" }),
  });
  const createRes = await fetch(`${BASE}/todos`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Not done" }),
  });
  const created = await createRes.json();
  await fetch(`${BASE}/todos/${created.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ completed: true }),
  });

  const res = await fetch(`${BASE}/todos?completed=true`);
  expect(res.status).toBe(200);
  const { todos } = await res.json();
  expect(todos.length).toBe(1);
  expect(todos[0].completed).toBe(true);
  expect(todos[0].title).toBe("Not done");
});

test("GET /todos?completed=false returns only incomplete todos", async () => {
  const createRes = await fetch(`${BASE}/todos`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Incomplete" }),
  });
  const created = await createRes.json();
  await fetch(`${BASE}/todos`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Complete" }),
  });
  const completedTodo = (await (await fetch(`${BASE}/todos`)).json()).todos.find((t: any) => t.title === "Complete");
  await fetch(`${BASE}/todos/${completedTodo.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ completed: true }),
  });

  const res = await fetch(`${BASE}/todos?completed=false`);
  expect(res.status).toBe(200);
  const { todos } = await res.json();
  expect(todos.every((t: any) => t.completed === false)).toBe(true);
  expect(todos.some((t: any) => t.id === created.id)).toBe(true);
});

test("GET /todos without filter returns all todos", async () => {
  await fetch(`${BASE}/todos`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "First" }),
  });
  const createRes = await fetch(`${BASE}/todos`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Second" }),
  });
  const second = await createRes.json();
  await fetch(`${BASE}/todos/${second.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ completed: true }),
  });

  const res = await fetch(`${BASE}/todos`);
  expect(res.status).toBe(200);
  const { todos } = await res.json();
  expect(todos.length).toBe(2);
});

test("GET /todos?q= filters by title search (case-insensitive)", async () => {
  await fetch(`${BASE}/todos`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Buy groceries" }),
  });
  await fetch(`${BASE}/todos`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Walk the dog" }),
  });
  await fetch(`${BASE}/todos`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Buy flowers" }),
  });

  const res = await fetch(`${BASE}/todos?q=buy`);
  expect(res.status).toBe(200);
  const { todos } = await res.json();
  expect(todos.length).toBe(2);
  expect(todos.every((t: any) => t.title.toLowerCase().includes("buy"))).toBe(true);
});

test("GET /todos?q= returns empty array when no matches", async () => {
  await fetch(`${BASE}/todos`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Walk the dog" }),
  });

  const res = await fetch(`${BASE}/todos?q=xyz`);
  expect(res.status).toBe(200);
  const { todos } = await res.json();
  expect(todos).toEqual([]);
});

test("GET /todos?q= combined with completed filter", async () => {
  const r1 = await fetch(`${BASE}/todos`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Buy milk" }),
  });
  const t1 = await r1.json();
  await fetch(`${BASE}/todos`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Buy eggs" }),
  });

  await fetch(`${BASE}/todos/${t1.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ completed: true }),
  });

  const res = await fetch(`${BASE}/todos?q=buy&completed=true`);
  expect(res.status).toBe(200);
  const { todos } = await res.json();
  expect(todos.length).toBe(1);
  expect(todos[0].title).toBe("Buy milk");
  expect(todos[0].completed).toBe(true);
});

afterAll(() => {
  server?.stop();
});
