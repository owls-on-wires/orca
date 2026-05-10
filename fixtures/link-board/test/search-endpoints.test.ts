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

async function createLink(token: string, title: string, url: string) {
  const res = await fetch(`${BASE}/links`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ title, url }),
  });
  return (await res.json()).link;
}

async function createComment(token: string, linkId: number, body: string) {
  const res = await fetch(`${BASE}/links/${linkId}/comments`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ body }),
  });
  return (await res.json()).comment;
}

describe("GET /search", () => {
  async function setup() {
    const token = await registerAndGetToken("alice", "alice@example.com", "secret123");
    const tsLink = await createLink(token, "TypeScript Guide", "https://ts.dev");
    const rustLink = await createLink(token, "Rust Handbook", "https://rust-lang.org");
    const comment = await createComment(token, tsLink.id, "TypeScript is great for web dev");
    return { token, tsLink, rustLink, comment };
  }

  test("returns matching links and comments for query", async () => {
    const { tsLink, comment } = await setup();

    const res = await fetch(`${BASE}/search?q=TypeScript`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.results.length).toBe(2);

    const types = data.results.map((r: any) => r.type);
    expect(types).toContain("link");
    expect(types).toContain("comment");
  });

  test("returns only matching results for Rust query", async () => {
    await setup();

    const res = await fetch(`${BASE}/search?q=Rust`);
    const data = await res.json();
    expect(data.results.length).toBe(1);
    expect(data.results[0].type).toBe("link");
    expect(data.results[0].title).toBe("Rust Handbook");
  });

  test("returns empty results for nonexistent query", async () => {
    await setup();

    const res = await fetch(`${BASE}/search?q=nonexistent`);
    const data = await res.json();
    expect(data.results).toEqual([]);
    expect(data.total).toBe(0);
  });

  test("search is case-insensitive", async () => {
    await setup();

    const res = await fetch(`${BASE}/search?q=typescript`);
    const data = await res.json();
    expect(data.results.length).toBe(2);
  });

  test("limit=1 returns 1 result with total count", async () => {
    await setup();

    const res = await fetch(`${BASE}/search?q=TypeScript&limit=1`);
    const data = await res.json();
    expect(data.results.length).toBe(1);
    expect(data.total).toBe(2);
  });

  test("limit=1&offset=1 returns the second result", async () => {
    await setup();

    const res1 = await fetch(`${BASE}/search?q=TypeScript&limit=1&offset=0`);
    const data1 = await res1.json();

    const res2 = await fetch(`${BASE}/search?q=TypeScript&limit=1&offset=1`);
    const data2 = await res2.json();

    expect(data2.results.length).toBe(1);
    expect(data2.results[0].type).not.toBe(data1.results[0].type);
  });

  test("link results include expected fields", async () => {
    await setup();

    const res = await fetch(`${BASE}/search?q=Rust`);
    const data = await res.json();
    const link = data.results[0];

    expect(link.id).toBeDefined();
    expect(link.type).toBe("link");
    expect(link.title).toBeDefined();
    expect(link.url).toBeDefined();
    expect(link.score).toBeDefined();
    expect(link.created_at).toBeDefined();
  });

  test("comment results include expected fields", async () => {
    await setup();

    const res = await fetch(`${BASE}/search?q=web+dev`);
    const data = await res.json();
    expect(data.results.length).toBe(1);
    const comment = data.results[0];

    expect(comment.id).toBeDefined();
    expect(comment.type).toBe("comment");
    expect(comment.body).toBeDefined();
    expect(comment.link_id).toBeDefined();
    expect(comment.score).toBeDefined();
    expect(comment.created_at).toBeDefined();
  });

  test("returns 400 without q param", async () => {
    const res = await fetch(`${BASE}/search`);
    expect(res.status).toBe(400);
  });
});
