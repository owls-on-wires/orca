import { describe, test, expect, beforeEach } from "bun:test";
import "../src/server";
import { resetDb } from "../src/db";

const BASE = "http://localhost:3458";

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
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ title, url }),
  });
  return (await res.json()).link;
}

describe("POST /links/:id/comments", () => {
  beforeEach(() => resetDb());

  test("creates a comment (authenticated), returns 201 with comment", async () => {
    const token = await registerAndGetToken("alice", "alice@example.com", "secret123");
    const link = await createLink(token, "Test", "https://test.com");

    const res = await fetch(`${BASE}/links/${link.id}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ body: "Great link!" }),
    });

    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.comment.id).toBeDefined();
    expect(data.comment.body).toBe("Great link!");
    expect(data.comment.link_id).toBe(link.id);
  });

  test("returns 401 without auth", async () => {
    const token = await registerAndGetToken("alice", "alice@example.com", "secret123");
    const link = await createLink(token, "Test", "https://test.com");

    const res = await fetch(`${BASE}/links/${link.id}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "Great link!" }),
    });

    expect(res.status).toBe(401);
  });

  test("returns 400 if body is missing", async () => {
    const token = await registerAndGetToken("alice", "alice@example.com", "secret123");
    const link = await createLink(token, "Test", "https://test.com");

    const res = await fetch(`${BASE}/links/${link.id}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
  });

  test("creates a reply with parent_id", async () => {
    const token = await registerAndGetToken("alice", "alice@example.com", "secret123");
    const link = await createLink(token, "Test", "https://test.com");

    const r1 = await fetch(`${BASE}/links/${link.id}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ body: "Top-level comment" }),
    });
    const parent = (await r1.json()).comment;

    const r2 = await fetch(`${BASE}/links/${link.id}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ body: "Reply", parent_id: parent.id }),
    });

    expect(r2.status).toBe(201);
    const data = await r2.json();
    expect(data.comment.parent_id).toBe(parent.id);
  });
});

describe("GET /links/:id/comments", () => {
  beforeEach(() => resetDb());

  test("returns nested tree of comments with author username, score, votes, replies", async () => {
    const token = await registerAndGetToken("alice", "alice@example.com", "secret123");
    const link = await createLink(token, "Test", "https://test.com");

    const r1 = await fetch(`${BASE}/links/${link.id}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ body: "Top-level" }),
    });
    const parent = (await r1.json()).comment;

    await fetch(`${BASE}/links/${link.id}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ body: "Reply", parent_id: parent.id }),
    });

    const res = await fetch(`${BASE}/links/${link.id}/comments`);
    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.comments.length).toBe(1);
    expect(data.comments[0].body).toBe("Top-level");
    expect(data.comments[0].username).toBe("alice");
    expect(data.comments[0]).toHaveProperty("score");
    expect(data.comments[0]).toHaveProperty("upvotes");
    expect(data.comments[0]).toHaveProperty("downvotes");
    expect(data.comments[0].replies.length).toBe(1);
    expect(data.comments[0].replies[0].body).toBe("Reply");
  });

  test("works without auth (current_user_vote is 0)", async () => {
    const token = await registerAndGetToken("alice", "alice@example.com", "secret123");
    const link = await createLink(token, "Test", "https://test.com");

    await fetch(`${BASE}/links/${link.id}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ body: "Hello" }),
    });

    const res = await fetch(`${BASE}/links/${link.id}/comments`);
    const data = await res.json();
    expect(data.comments[0].current_user_vote).toBe(0);
  });
});

describe("POST /comments/:id/vote", () => {
  beforeEach(() => resetDb());

  test("upvote a comment (auth required)", async () => {
    const token = await registerAndGetToken("alice", "alice@example.com", "secret123");
    const link = await createLink(token, "Test", "https://test.com");

    const r = await fetch(`${BASE}/links/${link.id}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ body: "Nice" }),
    });
    const comment = (await r.json()).comment;

    const res = await fetch(`${BASE}/comments/${comment.id}/vote`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ value: 1 }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.comment.upvotes).toBe(1);
  });

  test("downvote a comment", async () => {
    const token = await registerAndGetToken("alice", "alice@example.com", "secret123");
    const link = await createLink(token, "Test", "https://test.com");

    const r = await fetch(`${BASE}/links/${link.id}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ body: "Nice" }),
    });
    const comment = (await r.json()).comment;

    const res = await fetch(`${BASE}/comments/${comment.id}/vote`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ value: -1 }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.comment.downvotes).toBe(1);
  });

  test("change vote direction", async () => {
    const token = await registerAndGetToken("alice", "alice@example.com", "secret123");
    const link = await createLink(token, "Test", "https://test.com");

    const r = await fetch(`${BASE}/links/${link.id}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ body: "Nice" }),
    });
    const comment = (await r.json()).comment;

    await fetch(`${BASE}/comments/${comment.id}/vote`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ value: 1 }),
    });

    const res = await fetch(`${BASE}/comments/${comment.id}/vote`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ value: -1 }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.comment.downvotes).toBe(1);
    expect(data.comment.upvotes).toBe(0);
  });

  test("returns 401 without auth", async () => {
    const token = await registerAndGetToken("alice", "alice@example.com", "secret123");
    const link = await createLink(token, "Test", "https://test.com");

    const r = await fetch(`${BASE}/links/${link.id}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ body: "Nice" }),
    });
    const comment = (await r.json()).comment;

    const res = await fetch(`${BASE}/comments/${comment.id}/vote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: 1 }),
    });

    expect(res.status).toBe(401);
  });
});

describe("DELETE /comments/:id/vote", () => {
  beforeEach(() => resetDb());

  test("removes vote", async () => {
    const token = await registerAndGetToken("alice", "alice@example.com", "secret123");
    const link = await createLink(token, "Test", "https://test.com");

    const r = await fetch(`${BASE}/links/${link.id}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ body: "Nice" }),
    });
    const comment = (await r.json()).comment;

    await fetch(`${BASE}/comments/${comment.id}/vote`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ value: 1 }),
    });

    const res = await fetch(`${BASE}/comments/${comment.id}/vote`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.comment.score).toBe(0);
  });
});

describe("DELETE /comments/:id", () => {
  beforeEach(() => resetDb());

  test("soft-deletes own comment, body becomes [deleted]", async () => {
    const token = await registerAndGetToken("alice", "alice@example.com", "secret123");
    const link = await createLink(token, "Test", "https://test.com");

    const r = await fetch(`${BASE}/links/${link.id}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ body: "To be deleted" }),
    });
    const comment = (await r.json()).comment;

    const res = await fetch(`${BASE}/comments/${comment.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.comment.body).toBe("[deleted]");
  });

  test("returns 401 without auth", async () => {
    const token = await registerAndGetToken("alice", "alice@example.com", "secret123");
    const link = await createLink(token, "Test", "https://test.com");

    const r = await fetch(`${BASE}/links/${link.id}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ body: "Hello" }),
    });
    const comment = (await r.json()).comment;

    const res = await fetch(`${BASE}/comments/${comment.id}`, {
      method: "DELETE",
    });

    expect(res.status).toBe(401);
  });

  test("returns 403 if not the comment author", async () => {
    const token1 = await registerAndGetToken("alice", "alice@example.com", "secret123");
    const token2 = await registerAndGetToken("bob", "bob@example.com", "secret456");
    const link = await createLink(token1, "Test", "https://test.com");

    const r = await fetch(`${BASE}/links/${link.id}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token1}` },
      body: JSON.stringify({ body: "Alice's comment" }),
    });
    const comment = (await r.json()).comment;

    const res = await fetch(`${BASE}/comments/${comment.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token2}` },
    });

    expect(res.status).toBe(403);
  });

  test("deleted comment still appears in tree with body=[deleted] so replies are preserved", async () => {
    const token = await registerAndGetToken("alice", "alice@example.com", "secret123");
    const link = await createLink(token, "Test", "https://test.com");

    const r1 = await fetch(`${BASE}/links/${link.id}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ body: "Parent" }),
    });
    const parent = (await r1.json()).comment;

    await fetch(`${BASE}/links/${link.id}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ body: "Child reply", parent_id: parent.id }),
    });

    await fetch(`${BASE}/comments/${parent.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });

    const res = await fetch(`${BASE}/links/${link.id}/comments`);
    const data = await res.json();

    expect(data.comments.length).toBe(1);
    expect(data.comments[0].body).toBe("[deleted]");
    expect(data.comments[0].replies.length).toBe(1);
    expect(data.comments[0].replies[0].body).toBe("Child reply");
  });
});
