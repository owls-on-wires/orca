import { getDb } from "./db";

export interface Todo {
  id: number;
  title: string;
  completed: boolean;
  created_at: string;
}

export interface PaginatedTodos {
  todos: Todo[];
  total: number;
  page: number;
  limit: number;
}

export function listTodos(
  filter?: { completed?: boolean; search?: string },
  pagination?: { page?: number; limit?: number }
): PaginatedTodos {
  const db = getDb();
  const conditions: string[] = [];
  const params: any[] = [];

  if (filter?.completed !== undefined) {
    conditions.push("completed = ?");
    params.push(filter.completed ? 1 : 0);
  }
  if (filter?.search !== undefined) {
    conditions.push("title LIKE ?");
    params.push(`%${filter.search}%`);
  }

  const where = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";

  const page = Math.max(1, pagination?.page ?? 1);
  const limit = Math.min(100, Math.max(1, pagination?.limit ?? 20));
  const offset = (page - 1) * limit;

  const countRow = db.query(`SELECT COUNT(*) as count FROM todos${where}`).get(...params) as any;
  const total = countRow.count as number;
  const rows = db.query(`SELECT * FROM todos${where} LIMIT ? OFFSET ?`).all(...params, limit, offset) as any[];
  const todos = rows.map(r => ({ ...r, completed: !!r.completed }));

  return { todos, total, page, limit };
}

export function getTodo(id: number): Todo | null {
  const db = getDb();
  const row = db.query("SELECT * FROM todos WHERE id = ?").get(id) as any;
  if (!row) return null;
  return { ...row, completed: !!row.completed };
}

export function createTodo(title: string): Todo {
  if (!title.trim()) throw new Error("Title is required");
  const db = getDb();
  db.run("INSERT INTO todos (title) VALUES (?)", [title]);
  const id = db.query("SELECT last_insert_rowid() as id").get() as any;
  return getTodo(id.id)!;
}

export function updateTodo(id: number, updates: { title?: string; completed?: boolean }): Todo | null {
  const db = getDb();
  const existing = getTodo(id);
  if (!existing) return null;

  // BUG: doesn't actually update the completed field correctly
  if (updates.title !== undefined) {
    db.run("UPDATE todos SET title = ? WHERE id = ?", [updates.title, id]);
  }
  if (updates.completed !== undefined) {
    db.run("UPDATE todos SET completed = ? WHERE id = ?", [updates.completed ? 1 : 0, id]);
  }

  return getTodo(id);
}

export function deleteTodo(id: number): boolean {
  const db = getDb();
  // BUG: doesn't check if todo exists before deleting
  const result = db.run("DELETE FROM todos WHERE id = ?", [id]);
  return result.changes > 0;
}
