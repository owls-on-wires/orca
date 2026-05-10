import { expect, test, beforeEach } from "bun:test";
import { resetDb } from "../src/db";
import { listTodos, getTodo, createTodo, updateTodo, deleteTodo } from "../src/todos";

beforeEach(() => resetDb());

test("listTodos returns empty array initially", () => {
  expect(listTodos().todos).toEqual([]);
});

test("createTodo creates a todo with title", () => {
  const todo = createTodo("Buy groceries");
  expect(todo.title).toBe("Buy groceries");
  expect(todo.completed).toBe(false);
  expect(todo.id).toBeGreaterThan(0);
});

test("createTodo rejects empty title", () => {
  expect(() => createTodo("")).toThrow();
});

test("createTodo rejects whitespace-only title", () => {
  expect(() => createTodo("   ")).toThrow();
});

test("getTodo returns null for non-existent id", () => {
  expect(getTodo(999)).toBeNull();
});

test("getTodo returns created todo", () => {
  const created = createTodo("Test todo");
  const found = getTodo(created.id);
  expect(found).not.toBeNull();
  expect(found!.title).toBe("Test todo");
});

test("listTodos returns all todos", () => {
  createTodo("First");
  createTodo("Second");
  createTodo("Third");
  expect(listTodos().todos.length).toBe(3);
});

test("updateTodo changes title", () => {
  const todo = createTodo("Original");
  const updated = updateTodo(todo.id, { title: "Changed" });
  expect(updated!.title).toBe("Changed");
});

test("updateTodo toggles completed", () => {
  const todo = createTodo("Task");
  const updated = updateTodo(todo.id, { completed: true });
  expect(updated!.completed).toBe(true);
});

test("updateTodo returns null for non-existent id", () => {
  expect(updateTodo(999, { title: "nope" })).toBeNull();
});

test("deleteTodo removes a todo", () => {
  const todo = createTodo("Delete me");
  expect(deleteTodo(todo.id)).toBe(true);
  expect(getTodo(todo.id)).toBeNull();
});

test("deleteTodo returns false for non-existent id", () => {
  expect(deleteTodo(999)).toBe(false);
});

// Pagination tests

test("listTodos returns wrapper with todos, total, page, limit", () => {
  createTodo("A");
  createTodo("B");
  const result = listTodos();
  expect(Array.isArray(result.todos)).toBe(true);
  expect(result.total).toBe(2);
  expect(result.page).toBe(1);
  expect(result.limit).toBe(20);
});

test("listTodos pagination: page=1 limit=2 returns first two items", () => {
  createTodo("A");
  createTodo("B");
  createTodo("C");
  createTodo("D");
  createTodo("E");
  const result = listTodos(undefined, { page: 1, limit: 2 });
  expect(result.todos.length).toBe(2);
  expect(result.total).toBe(5);
  expect(result.page).toBe(1);
  expect(result.limit).toBe(2);
});

test("listTodos pagination: page=2 limit=2 returns next two items", () => {
  createTodo("A");
  createTodo("B");
  createTodo("C");
  createTodo("D");
  createTodo("E");
  const p1 = listTodos(undefined, { page: 1, limit: 2 });
  const p2 = listTodos(undefined, { page: 2, limit: 2 });
  expect(p2.todos.length).toBe(2);
  const p1Ids = p1.todos.map(t => t.id);
  const p2Ids = p2.todos.map(t => t.id);
  expect(p2Ids.every(id => !p1Ids.includes(id))).toBe(true);
});

test("listTodos pagination: total reflects full count regardless of page", () => {
  createTodo("A");
  createTodo("B");
  createTodo("C");
  const result = listTodos(undefined, { page: 1, limit: 1 });
  expect(result.total).toBe(3);
  expect(result.todos.length).toBe(1);
});

test("listTodos pagination: page beyond results returns empty todos with correct total", () => {
  createTodo("A");
  createTodo("B");
  createTodo("C");
  const result = listTodos(undefined, { page: 99, limit: 10 });
  expect(result.todos).toEqual([]);
  expect(result.total).toBe(3);
  expect(result.page).toBe(99);
});

test("listTodos pagination: limit=0 is clamped to 1", () => {
  createTodo("A");
  createTodo("B");
  const result = listTodos(undefined, { limit: 0 });
  expect(result.limit).toBe(1);
  expect(result.todos.length).toBeLessThanOrEqual(1);
});

test("listTodos pagination: limit above 100 is clamped to 100", () => {
  const result = listTodos(undefined, { limit: 999 });
  expect(result.limit).toBe(100);
});

test("listTodos pagination: works with filter", () => {
  createTodo("Buy milk");
  createTodo("Buy eggs");
  createTodo("Buy bread");
  createTodo("Walk dog");
  const result = listTodos({ search: "Buy" }, { page: 1, limit: 2 });
  expect(result.total).toBe(3);
  expect(result.todos.length).toBe(2);
  expect(result.todos.every(t => t.title.includes("Buy"))).toBe(true);
});

test("listTodos pagination: page=2 with filter returns remaining items", () => {
  createTodo("Buy milk");
  createTodo("Buy eggs");
  createTodo("Buy bread");
  createTodo("Walk dog");
  const result = listTodos({ search: "Buy" }, { page: 2, limit: 2 });
  expect(result.todos.length).toBe(1);
  expect(result.todos[0].title).toBe("Buy bread");
});
