import { describe, test, expect, beforeEach } from "bun:test";
import "../src/server";
import { resetDb } from "../src/db";

const BASE = "http://localhost:3458";

beforeEach(() => resetDb());

async function registerAndGetToken(username: string, email: string, password: string): Promise<string> {
  const res = await fetch(`${BASE}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, email, password }),
  });
  const data = await res.json();
  return data.token;
}

describe("POST /links", () => {
  test("creates a link (authenticated), returns 201 with link object", async () => {
    const token = await registerAndGetToken("alice", "alice@example.com", "secret123");

    const res = await fetch(`${BASE}/links`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ title: "Example", url: "https://example.com" }),
    });

    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.link.id).toBeDefined();
    expect(data.link.title).toBe("Example");
    expect(data.link.url).toBe("https://example.com");
    expect(data.link.user_id).toBeDefined();
  });

  test("returns 401 without auth token", async () => {
    const res = await fetch(`${BASE}/links`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Example", url: "https://example.com" }),
    });

    expect(res.status).toBe(401);
  });

  test("returns 400 if title or url missing", async () => {
    const token = await registerAndGetToken("alice", "alice@example.com", "secret123");

    const res1 = await fetch(`${BASE}/links`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ url: "https://example.com" }),
    });
    expect(res1.status).toBe(400);

    const res2 = await fetch(`${BASE}/links`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ title: "Example" }),
    });
    expect(res2.status).toBe(400);
  });
});

describe("GET /links", () => {
  test("returns paginated links (default sort: newest) with vote fields", async () => {
    const token = await registerAndGetToken("alice", "alice@example.com", "secret123");

    await fetch(`${BASE}/links`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ title: "First", url: "https://first.com" }),
    });
    await fetch(`${BASE}/links`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ title: "Second", url: "https://second.com" }),
    });

    const res = await fetch(`${BASE}/links`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.links.length).toBe(2);
    // newest first
    expect(data.links[0].title).toBe("Second");
    expect(data.links[1].title).toBe("First");
    // vote fields present
    expect(data.links[0]).toHaveProperty("id");
    expect(data.links[0]).toHaveProperty("title");
    expect(data.links[0]).toHaveProperty("url");
    expect(data.links[0]).toHaveProperty("score");
    expect(data.links[0]).toHaveProperty("upvotes");
    expect(data.links[0]).toHaveProperty("downvotes");
  });

  test("sort=top returns links sorted by score descending", async () => {
    const token1 = await registerAndGetToken("alice", "alice@example.com", "secret123");
    const token2 = await registerAndGetToken("bob", "bob@example.com", "secret456");

    const r1 = await fetch(`${BASE}/links`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token1}` },
      body: JSON.stringify({ title: "Unpopular", url: "https://unpopular.com" }),
    });
    const link1 = (await r1.json()).link;

    const r2 = await fetch(`${BASE}/links`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token1}` },
      body: JSON.stringify({ title: "Popular", url: "https://popular.com" }),
    });
    const link2 = (await r2.json()).link;

    await fetch(`${BASE}/links/${link2.id}/vote`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token1}` },
      body: JSON.stringify({ value: 1 }),
    });
    await fetch(`${BASE}/links/${link2.id}/vote`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token2}` },
      body: JSON.stringify({ value: 1 }),
    });

    const res = await fetch(`${BASE}/links?sort=top`);
    const data = await res.json();
    expect(data.links[0].title).toBe("Popular");
    expect(data.links[1].title).toBe("Unpopular");
  });

  test("limit and offset pagination works", async () => {
    const token = await registerAndGetToken("alice", "alice@example.com", "secret123");

    for (let i = 1; i <= 3; i++) {
      await fetch(`${BASE}/links`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ title: `Link ${i}`, url: `https://link${i}.com` }),
      });
    }

    const res = await fetch(`${BASE}/links?limit=2&offset=0`);
    const data = await res.json();
    expect(data.links.length).toBe(2);
  });

  test("includes current_user_vote when authenticated", async () => {
    const token = await registerAndGetToken("alice", "alice@example.com", "secret123");

    const r = await fetch(`${BASE}/links`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ title: "Test", url: "https://test.com" }),
    });
    const link = (await r.json()).link;

    await fetch(`${BASE}/links/${link.id}/vote`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ value: 1 }),
    });

    const res = await fetch(`${BASE}/links`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    expect(data.links[0].current_user_vote).toBe(1);
  });
});

describe("POST /links/:id/vote", () => {
  test("upvote a link returns 200", async () => {
    const token = await registerAndGetToken("alice", "alice@example.com", "secret123");

    const r = await fetch(`${BASE}/links`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ title: "Test", url: "https://test.com" }),
    });
    const link = (await r.json()).link;

    const res = await fetch(`${BASE}/links/${link.id}/vote`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ value: 1 }),
    });
    expect(res.status).toBe(200);
  });

  test("downvote a link returns 200", async () => {
    const token = await registerAndGetToken("alice", "alice@example.com", "secret123");

    const r = await fetch(`${BASE}/links`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ title: "Test", url: "https://test.com" }),
    });
    const link = (await r.json()).link;

    const res = await fetch(`${BASE}/links/${link.id}/vote`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ value: -1 }),
    });
    expect(res.status).toBe(200);
  });

  test("change vote direction works", async () => {
    const token = await registerAndGetToken("alice", "alice@example.com", "secret123");

    const r = await fetch(`${BASE}/links`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ title: "Test", url: "https://test.com" }),
    });
    const link = (await r.json()).link;

    await fetch(`${BASE}/links/${link.id}/vote`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ value: 1 }),
    });

    const res = await fetch(`${BASE}/links/${link.id}/vote`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ value: -1 }),
    });
    expect(res.status).toBe(200);

    const linkRes = await fetch(`${BASE}/links/${link.id}`);
    const data = await linkRes.json();
    expect(data.link.downvotes).toBe(1);
    expect(data.link.upvotes).toBe(0);
  });

  test("returns 401 without auth", async () => {
    const token = await registerAndGetToken("alice", "alice@example.com", "secret123");

    const r = await fetch(`${BASE}/links`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ title: "Test", url: "https://test.com" }),
    });
    const link = (await r.json()).link;

    const res = await fetch(`${BASE}/links/${link.id}/vote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: 1 }),
    });
    expect(res.status).toBe(401);
  });
});

describe("DELETE /links/:id/vote", () => {
  test("removes vote, returns 200", async () => {
    const token = await registerAndGetToken("alice", "alice@example.com", "secret123");

    const r = await fetch(`${BASE}/links`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ title: "Test", url: "https://test.com" }),
    });
    const link = (await r.json()).link;

    await fetch(`${BASE}/links/${link.id}/vote`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ value: 1 }),
    });

    const res = await fetch(`${BASE}/links/${link.id}/vote`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);

    const linkRes = await fetch(`${BASE}/links/${link.id}`);
    const data = await linkRes.json();
    expect(data.link.score).toBe(0);
  });
});

describe("GET /links/:id", () => {
  test("returns single link with vote counts", async () => {
    const token1 = await registerAndGetToken("alice", "alice@example.com", "secret123");
    const token2 = await registerAndGetToken("bob", "bob@example.com", "secret456");

    const r = await fetch(`${BASE}/links`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token1}` },
      body: JSON.stringify({ title: "Test", url: "https://test.com" }),
    });
    const link = (await r.json()).link;

    await fetch(`${BASE}/links/${link.id}/vote`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token1}` },
      body: JSON.stringify({ value: 1 }),
    });
    await fetch(`${BASE}/links/${link.id}/vote`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token2}` },
      body: JSON.stringify({ value: 1 }),
    });

    const res = await fetch(`${BASE}/links/${link.id}`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.link.id).toBe(link.id);
    expect(data.link.title).toBe("Test");
    expect(data.link.url).toBe("https://test.com");
    expect(data.link.upvotes).toBe(2);
    expect(data.link.downvotes).toBe(0);
    expect(data.link.score).toBe(2);
  });
});
