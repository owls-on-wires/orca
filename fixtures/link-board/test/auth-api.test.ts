import { describe, test, expect, beforeEach } from "bun:test";
import { resetDb } from "../src/db";
import "../src/server";

const BASE = "http://localhost:3458";

beforeEach(() => resetDb());

describe("POST /register", () => {
  test("registers first user, returns 201 with user and token", async () => {
    const res = await fetch(`${BASE}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "alice", email: "alice@example.com", password: "secret" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.user.username).toBe("alice");
    expect(body.user.is_admin).toBe(1);
    expect(typeof body.token).toBe("string");
  });

  test("returns 400 when password is missing", async () => {
    const res = await fetch(`${BASE}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "alice", email: "alice@example.com" }),
    });
    expect(res.status).toBe(400);
  });

  test("returns 409 on duplicate username", async () => {
    await fetch(`${BASE}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "alice", email: "alice@example.com", password: "secret" }),
    });
    const res = await fetch(`${BASE}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "alice", email: "other@example.com", password: "secret" }),
    });
    expect(res.status).toBe(409);
  });

  test("returns 409 on duplicate email", async () => {
    await fetch(`${BASE}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "alice", email: "alice@example.com", password: "secret" }),
    });
    const res = await fetch(`${BASE}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "other", email: "alice@example.com", password: "secret" }),
    });
    expect(res.status).toBe(409);
  });
});

describe("POST /login", () => {
  beforeEach(async () => {
    await fetch(`${BASE}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "alice", email: "alice@example.com", password: "secret" }),
    });
  });

  test("returns 200 with user and token for correct credentials", async () => {
    const res = await fetch(`${BASE}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "alice@example.com", password: "secret" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user).toBeDefined();
    expect(body.token).toBeDefined();
  });

  test("returns 401 for wrong password", async () => {
    const res = await fetch(`${BASE}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "alice@example.com", password: "wrong" }),
    });
    expect(res.status).toBe(401);
  });

  test("returns 404 for unknown email", async () => {
    const res = await fetch(`${BASE}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "nobody@example.com", password: "secret" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("GET /me", () => {
  test("returns 200 with user for valid Bearer token", async () => {
    const regRes = await fetch(`${BASE}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "alice", email: "alice@example.com", password: "secret" }),
    });
    const { token } = await regRes.json();

    const res = await fetch(`${BASE}/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user.username).toBe("alice");
  });

  test("returns 401 with no Authorization header", async () => {
    const res = await fetch(`${BASE}/me`);
    expect(res.status).toBe(401);
  });

  test("returns 401 with invalid token string", async () => {
    const res = await fetch(`${BASE}/me`, {
      headers: { Authorization: "Bearer invalidtoken" },
    });
    expect(res.status).toBe(401);
  });
});
