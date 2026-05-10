import { describe, test, expect, beforeEach } from "bun:test";
import "../src/server"; // starts server on port 3458
import { resetDb } from "../src/db";

const BASE = "http://localhost:3458";

beforeEach(() => resetDb());

describe("POST /register", () => {
  test("201 with valid body", async () => {
    const res = await fetch(`${BASE}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "alice",
        email: "alice@example.com",
        password: "secret123",
      }),
    });

    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.user.id).toBeDefined();
    expect(data.user.username).toBe("alice");
    expect(data.user.email).toBe("alice@example.com");
    expect(data.user.created_at).toBeDefined();
    expect(data.token).toBeDefined();
  });

  test("400 when username is missing", async () => {
    const res = await fetch(`${BASE}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "alice@example.com",
        password: "secret123",
      }),
    });

    expect(res.status).toBe(400);
  });

  test("400 when email is missing", async () => {
    const res = await fetch(`${BASE}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "alice",
        password: "secret123",
      }),
    });

    expect(res.status).toBe(400);
  });

  test("400 when password is missing", async () => {
    const res = await fetch(`${BASE}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "alice",
        email: "alice@example.com",
      }),
    });

    expect(res.status).toBe(400);
  });

  test("409 when email is already taken", async () => {
    await fetch(`${BASE}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "alice",
        email: "alice@example.com",
        password: "secret123",
      }),
    });

    const res = await fetch(`${BASE}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "bob",
        email: "alice@example.com",
        password: "secret456",
      }),
    });

    expect(res.status).toBe(409);
  });

  test("409 when username is already taken", async () => {
    await fetch(`${BASE}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "alice",
        email: "alice@example.com",
        password: "secret123",
      }),
    });

    const res = await fetch(`${BASE}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "alice",
        email: "bob@example.com",
        password: "secret456",
      }),
    });

    expect(res.status).toBe(409);
  });
});

describe("POST /login", () => {
  beforeEach(async () => {
    await fetch(`${BASE}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "alice",
        email: "alice@example.com",
        password: "secret123",
      }),
    });
  });

  test("200 with user and token for correct credentials", async () => {
    const res = await fetch(`${BASE}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "alice@example.com",
        password: "secret123",
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.user).toBeDefined();
    expect(data.token).toBeDefined();
  });

  test("401 for wrong password", async () => {
    const res = await fetch(`${BASE}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "alice@example.com",
        password: "wrongpassword",
      }),
    });

    expect(res.status).toBe(401);
  });

  test("404 for unknown email", async () => {
    const res = await fetch(`${BASE}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "nobody@example.com",
        password: "secret123",
      }),
    });

    expect(res.status).toBe(404);
  });
});

describe("GET /me", () => {
  let token: string;

  beforeEach(async () => {
    const res = await fetch(`${BASE}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "alice",
        email: "alice@example.com",
        password: "secret123",
      }),
    });
    const data = await res.json();
    token = data.token;
  });

  test("200 with user when valid token", async () => {
    const res = await fetch(`${BASE}/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.user.id).toBeDefined();
    expect(data.user.username).toBe("alice");
    expect(data.user.email).toBe("alice@example.com");
  });

  test("401 when no Authorization header", async () => {
    const res = await fetch(`${BASE}/me`);
    expect(res.status).toBe(401);
  });

  test("401 when token is invalid", async () => {
    const res = await fetch(`${BASE}/me`, {
      headers: { Authorization: "Bearer garbage.invalid.token" },
    });
    expect(res.status).toBe(401);
  });
});
