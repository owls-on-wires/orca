import { describe, test, expect, beforeEach } from "bun:test";
import "../src/server";
import { resetDb } from "../src/db";

const BASE = "http://localhost:3458";

beforeEach(() => resetDb());

async function registerAndGetToken(username: string, email: string, password: string): Promise<{ token: string; userId: number }> {
  const res = await fetch(`${BASE}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, email, password }),
  });
  const data = await res.json();
  return { token: data.token, userId: data.user.id };
}

async function createLink(token: string, title: string, url: string) {
  const res = await fetch(`${BASE}/links`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ title, url }),
  });
  return (await res.json()).link;
}

async function createComment(token: string, linkId: number, body: string) {
  const res = await fetch(`${BASE}/links/${linkId}/comments`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ body }),
  });
  return (await res.json()).comment;
}

describe("Flagging", () => {
  test("POST /links/:id/flag with auth — returns 201 with flag object", async () => {
    const admin = await registerAndGetToken("admin", "admin@test.com", "pass");
    const link = await createLink(admin.token, "Test Link", "https://example.com");

    const res = await fetch(`${BASE}/links/${link.id}/flag`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${admin.token}` },
      body: JSON.stringify({ reason: "spam" }),
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.flag).toBeDefined();
    expect(data.flag.target_type).toBe("link");
    expect(data.flag.target_id).toBe(link.id);
  });

  test("POST /comments/:id/flag with auth — returns 201", async () => {
    const admin = await registerAndGetToken("admin", "admin@test.com", "pass");
    const link = await createLink(admin.token, "Test Link", "https://example.com");
    const comment = await createComment(admin.token, link.id, "bad comment");

    const res = await fetch(`${BASE}/comments/${comment.id}/flag`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${admin.token}` },
      body: JSON.stringify({ reason: "offensive" }),
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.flag.target_type).toBe("comment");
  });

  test("POST /links/:id/flag without auth — returns 401", async () => {
    const admin = await registerAndGetToken("admin", "admin@test.com", "pass");
    const link = await createLink(admin.token, "Test Link", "https://example.com");

    const res = await fetch(`${BASE}/links/${link.id}/flag`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
  });

  test("POST /links/:id/flag duplicate — returns 409", async () => {
    const admin = await registerAndGetToken("admin", "admin@test.com", "pass");
    const link = await createLink(admin.token, "Test Link", "https://example.com");

    await fetch(`${BASE}/links/${link.id}/flag`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${admin.token}` },
      body: JSON.stringify({}),
    });

    const res = await fetch(`${BASE}/links/${link.id}/flag`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${admin.token}` },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(409);
  });
});

describe("Admin detection", () => {
  test("first registered user is admin", async () => {
    const admin = await registerAndGetToken("first", "first@test.com", "pass");
    const res = await fetch(`${BASE}/me`, {
      headers: { Authorization: `Bearer ${admin.token}` },
    });
    const data = await res.json();
    expect(data.user.is_admin).toBe(1);
  });

  test("second registered user is NOT admin", async () => {
    await registerAndGetToken("first", "first@test.com", "pass");
    const second = await registerAndGetToken("second", "second@test.com", "pass");
    const res = await fetch(`${BASE}/me`, {
      headers: { Authorization: `Bearer ${second.token}` },
    });
    const data = await res.json();
    expect(data.user.is_admin).toBe(0);
  });
});

describe("Admin endpoints", () => {
  test("GET /moderation/flagged with admin auth — returns flagged items", async () => {
    const admin = await registerAndGetToken("admin", "admin@test.com", "pass");
    const link = await createLink(admin.token, "Flagged Link", "https://example.com");
    await fetch(`${BASE}/links/${link.id}/flag`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${admin.token}` },
      body: JSON.stringify({}),
    });

    const res = await fetch(`${BASE}/moderation/flagged`, {
      headers: { Authorization: `Bearer ${admin.token}` },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data.flagged)).toBe(true);
    expect(data.flagged.length).toBe(1);
  });

  test("GET /moderation/flagged without auth — returns 401", async () => {
    const res = await fetch(`${BASE}/moderation/flagged`);
    expect(res.status).toBe(401);
  });

  test("GET /moderation/flagged with non-admin auth — returns 403", async () => {
    await registerAndGetToken("admin", "admin@test.com", "pass");
    const user = await registerAndGetToken("user", "user@test.com", "pass");

    const res = await fetch(`${BASE}/moderation/flagged`, {
      headers: { Authorization: `Bearer ${user.token}` },
    });
    expect(res.status).toBe(403);
  });

  test("DELETE /admin/links/:id with admin auth — hard deletes link", async () => {
    const admin = await registerAndGetToken("admin", "admin@test.com", "pass");
    const link = await createLink(admin.token, "Delete Me", "https://example.com");

    const res = await fetch(`${BASE}/admin/links/${link.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${admin.token}` },
    });
    expect(res.status).toBe(200);

    const check = await fetch(`${BASE}/links/${link.id}`);
    expect(check.status).toBe(404);
  });

  test("DELETE /admin/links/:id with non-admin auth — returns 403", async () => {
    await registerAndGetToken("admin", "admin@test.com", "pass");
    const user = await registerAndGetToken("user", "user@test.com", "pass");
    const link = await createLink(user.token, "Link", "https://example.com");

    const res = await fetch(`${BASE}/admin/links/${link.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${user.token}` },
    });
    expect(res.status).toBe(403);
  });

  test("DELETE /admin/comments/:id with admin auth — hard deletes comment", async () => {
    const admin = await registerAndGetToken("admin", "admin@test.com", "pass");
    const link = await createLink(admin.token, "Link", "https://example.com");
    const comment = await createComment(admin.token, link.id, "Delete this comment");

    const res = await fetch(`${BASE}/admin/comments/${comment.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${admin.token}` },
    });
    expect(res.status).toBe(200);

    const check = await fetch(`${BASE}/links/${link.id}/comments`);
    const data = await check.json();
    expect(data.comments.length).toBe(0);
  });
});

describe("Banning", () => {
  test("POST /admin/users/:id/ban with admin auth — bans user", async () => {
    const admin = await registerAndGetToken("admin", "admin@test.com", "pass");
    const user = await registerAndGetToken("user", "user@test.com", "pass");

    const res = await fetch(`${BASE}/admin/users/${user.userId}/ban`, {
      method: "POST",
      headers: { Authorization: `Bearer ${admin.token}` },
    });
    expect(res.status).toBe(200);
  });

  test("banned user trying to POST /links — returns 403", async () => {
    const admin = await registerAndGetToken("admin", "admin@test.com", "pass");
    const user = await registerAndGetToken("user", "user@test.com", "pass");

    await fetch(`${BASE}/admin/users/${user.userId}/ban`, {
      method: "POST",
      headers: { Authorization: `Bearer ${admin.token}` },
    });

    const res = await fetch(`${BASE}/links`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${user.token}` },
      body: JSON.stringify({ title: "Banned Post", url: "https://example.com" }),
    });
    expect(res.status).toBe(403);
  });

  test("banned user trying to POST /links/:id/comments — returns 403", async () => {
    const admin = await registerAndGetToken("admin", "admin@test.com", "pass");
    const link = await createLink(admin.token, "Link", "https://example.com");
    const user = await registerAndGetToken("user", "user@test.com", "pass");

    await fetch(`${BASE}/admin/users/${user.userId}/ban`, {
      method: "POST",
      headers: { Authorization: `Bearer ${admin.token}` },
    });

    const res = await fetch(`${BASE}/links/${link.id}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${user.token}` },
      body: JSON.stringify({ body: "Banned comment" }),
    });
    expect(res.status).toBe(403);
  });

  test("banned user trying to POST /links/:id/vote — returns 403", async () => {
    const admin = await registerAndGetToken("admin", "admin@test.com", "pass");
    const link = await createLink(admin.token, "Link", "https://example.com");
    const user = await registerAndGetToken("user", "user@test.com", "pass");

    await fetch(`${BASE}/admin/users/${user.userId}/ban`, {
      method: "POST",
      headers: { Authorization: `Bearer ${admin.token}` },
    });

    const res = await fetch(`${BASE}/links/${link.id}/vote`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${user.token}` },
      body: JSON.stringify({ value: 1 }),
    });
    expect(res.status).toBe(403);
  });

  test("POST /admin/users/:id/unban with admin auth — unbans user", async () => {
    const admin = await registerAndGetToken("admin", "admin@test.com", "pass");
    const user = await registerAndGetToken("user", "user@test.com", "pass");

    await fetch(`${BASE}/admin/users/${user.userId}/ban`, {
      method: "POST",
      headers: { Authorization: `Bearer ${admin.token}` },
    });

    const res = await fetch(`${BASE}/admin/users/${user.userId}/unban`, {
      method: "POST",
      headers: { Authorization: `Bearer ${admin.token}` },
    });
    expect(res.status).toBe(200);
  });

  test("unbanned user can post again", async () => {
    const admin = await registerAndGetToken("admin", "admin@test.com", "pass");
    const user = await registerAndGetToken("user", "user@test.com", "pass");

    await fetch(`${BASE}/admin/users/${user.userId}/ban`, {
      method: "POST",
      headers: { Authorization: `Bearer ${admin.token}` },
    });
    await fetch(`${BASE}/admin/users/${user.userId}/unban`, {
      method: "POST",
      headers: { Authorization: `Bearer ${admin.token}` },
    });

    const res = await fetch(`${BASE}/links`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${user.token}` },
      body: JSON.stringify({ title: "Back!", url: "https://example.com" }),
    });
    expect(res.status).toBe(201);
  });

  test("POST /admin/users/:id/ban with non-admin — returns 403", async () => {
    await registerAndGetToken("admin", "admin@test.com", "pass");
    const user = await registerAndGetToken("user", "user@test.com", "pass");
    const other = await registerAndGetToken("other", "other@test.com", "pass");

    const res = await fetch(`${BASE}/admin/users/${other.userId}/ban`, {
      method: "POST",
      headers: { Authorization: `Bearer ${user.token}` },
    });
    expect(res.status).toBe(403);
  });
});
