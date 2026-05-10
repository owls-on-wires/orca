import { beforeEach, describe, test, expect } from "bun:test";
import { resetDb } from "../src/db";
import "../src/server";

beforeEach(() => resetDb());

const BASE = "http://localhost:3458";

async function register(username: string, email: string, password: string) {
  const res = await fetch(`${BASE}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, email, password }),
  });
  return res.json() as Promise<{ user: any; token: string }>;
}

describe("profile endpoints", () => {
  test("GET /users/:username returns 404 for nonexistent user", async () => {
    const res = await fetch(`${BASE}/users/nobody`);
    expect(res.status).toBe(404);
  });

  test("GET /users/:username returns profile fields", async () => {
    await register("alice", "alice@test.com", "password123");
    const res = await fetch(`${BASE}/users/alice`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.profile.username).toBe("alice");
    expect(typeof body.profile.karma).toBe("number");
    expect(body.profile.created_at).toBeDefined();
    expect(typeof body.profile.link_count).toBe("number");
    expect(typeof body.profile.comment_count).toBe("number");
    expect(body.profile).toHaveProperty("bio");
  });

  test("profile karma reflects votes on user's links", async () => {
    const { token: token1 } = await register("alice", "alice@test.com", "pass1");
    const { token: token2 } = await register("bob", "bob@test.com", "pass2");

    const linkRes = await fetch(`${BASE}/links`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token1}` },
      body: JSON.stringify({ title: "Test Link", url: "https://example.com" }),
    });
    const { link } = (await linkRes.json()) as any;

    await fetch(`${BASE}/links/${link.id}/vote`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token2}` },
      body: JSON.stringify({ value: 1 }),
    });

    const profileRes = await fetch(`${BASE}/users/alice`);
    const { profile } = (await profileRes.json()) as any;
    expect(profile.karma).toBe(1);
  });

  test("profile karma reflects votes on user's comments too", async () => {
    const { token: token1 } = await register("alice", "alice@test.com", "pass1");
    const { token: token2 } = await register("bob", "bob@test.com", "pass2");

    const linkRes = await fetch(`${BASE}/links`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token1}` },
      body: JSON.stringify({ title: "Test Link", url: "https://example.com" }),
    });
    const { link } = (await linkRes.json()) as any;

    await fetch(`${BASE}/links/${link.id}/vote`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token2}` },
      body: JSON.stringify({ value: 1 }),
    });

    const commentRes = await fetch(`${BASE}/links/${link.id}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token1}` },
      body: JSON.stringify({ body: "A comment" }),
    });
    const { comment } = (await commentRes.json()) as any;

    await fetch(`${BASE}/comments/${comment.id}/vote`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token2}` },
      body: JSON.stringify({ value: 1 }),
    });

    const profileRes = await fetch(`${BASE}/users/alice`);
    const { profile } = (await profileRes.json()) as any;
    expect(profile.karma).toBe(2);
  });

  test("GET /users/:username/links returns paginated links", async () => {
    const { token } = await register("alice", "alice@test.com", "pass1");

    for (let i = 1; i <= 3; i++) {
      await fetch(`${BASE}/links`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ title: `Link ${i}`, url: `https://example.com/${i}` }),
      });
    }

    const res = await fetch(`${BASE}/users/alice/links?limit=2&offset=0`);
    expect(res.status).toBe(200);
    const { links } = (await res.json()) as any;
    expect(links.length).toBe(2);
    expect(links[0].title).toBeDefined();
    expect(links[0].url).toBeDefined();
    expect(links[0].score).toBeDefined();
  });

  test("GET /users/:username/links?limit=2&offset=2 returns 1 link", async () => {
    const { token } = await register("alice", "alice@test.com", "pass1");

    for (let i = 1; i <= 3; i++) {
      await fetch(`${BASE}/links`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ title: `Link ${i}`, url: `https://example.com/${i}` }),
      });
    }

    const res = await fetch(`${BASE}/users/alice/links?limit=2&offset=2`);
    const { links } = (await res.json()) as any;
    expect(links.length).toBe(1);
  });

  test("GET /users/:username/comments returns paginated comments", async () => {
    const { token } = await register("alice", "alice@test.com", "pass1");

    const linkRes = await fetch(`${BASE}/links`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ title: "Test Link", url: "https://example.com" }),
    });
    const { link } = (await linkRes.json()) as any;

    for (let i = 1; i <= 3; i++) {
      await fetch(`${BASE}/links/${link.id}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ body: `Comment ${i}` }),
      });
    }

    const res = await fetch(`${BASE}/users/alice/comments?limit=2`);
    expect(res.status).toBe(200);
    const { comments } = (await res.json()) as any;
    expect(comments.length).toBe(2);
    expect(comments[0].body).toBeDefined();
    expect(comments[0].link_id).toBeDefined();
    expect(comments[0].score).toBeDefined();
  });

  test("PATCH /users/:username with auth returns 200 and updates bio", async () => {
    const { token } = await register("alice", "alice@test.com", "pass1");

    const res = await fetch(`${BASE}/users/alice`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ bio: "Hello world" }),
    });
    expect(res.status).toBe(200);
  });

  test("PATCH /users/:username without auth returns 401", async () => {
    await register("alice", "alice@test.com", "pass1");

    const res = await fetch(`${BASE}/users/alice`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bio: "Hello world" }),
    });
    expect(res.status).toBe(401);
  });

  test("PATCH /users/:username by different user returns 403", async () => {
    await register("alice", "alice@test.com", "pass1");
    const { token: token2 } = await register("bob", "bob@test.com", "pass2");

    const res = await fetch(`${BASE}/users/alice`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token2}` },
      body: JSON.stringify({ bio: "Hacked" }),
    });
    expect(res.status).toBe(403);
  });

  test("after PATCH bio, GET /users/:username shows updated bio", async () => {
    const { token } = await register("alice", "alice@test.com", "pass1");

    await fetch(`${BASE}/users/alice`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ bio: "Updated bio" }),
    });

    const res = await fetch(`${BASE}/users/alice`);
    const { profile } = (await res.json()) as any;
    expect(profile.bio).toBe("Updated bio");
  });
});
