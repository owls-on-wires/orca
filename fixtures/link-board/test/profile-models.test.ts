import { describe, test, expect, beforeEach } from "bun:test";
import {
  resetDb,
  createUser,
  createLink,
  createComment,
  voteOnLink,
  voteOnComment,
  getUserProfile,
  getUserLinks,
  getUserComments,
  updateUserBio,
} from "../src/db";

beforeEach(() => resetDb());

describe("getUserProfile", () => {
  test("returns username, karma, created_at, link_count, comment_count, bio for a user", () => {
    createUser({ username: "alice", email: "alice@test.com", passwordHash: "hash123" });

    const profile = getUserProfile("alice");

    expect(profile).not.toBeNull();
    expect(profile!.username).toBe("alice");
    expect(profile!.karma).toBeDefined();
    expect(profile!.created_at).toBeDefined();
    expect(profile!.link_count).toBeDefined();
    expect(profile!.comment_count).toBeDefined();
    expect(profile!.bio).toBeDefined();
  });

  test("karma equals sum of vote directions on user's links and comments", () => {
    const alice = createUser({ username: "alice", email: "alice@test.com", passwordHash: "hash123" });
    const bob = createUser({ username: "bob", email: "bob@test.com", passwordHash: "hash123" });

    const link = createLink({ title: "Link 1", url: "http://example.com", userId: alice.id });
    const comment = createComment({ body: "A comment", userId: alice.id, linkId: link.id });

    voteOnLink({ userId: bob.id, linkId: link.id, direction: 1 });
    voteOnComment({ userId: bob.id, commentId: comment.id, direction: -1 });

    const profile = getUserProfile("alice");
    expect(profile!.karma).toBe(0); // 1 + (-1) = 0
  });

  test("returns null for nonexistent username", () => {
    const profile = getUserProfile("nonexistent");
    expect(profile).toBeNull();
  });
});

describe("getUserLinks", () => {
  test("returns paginated links submitted by user", () => {
    const alice = createUser({ username: "alice", email: "alice@test.com", passwordHash: "hash123" });

    createLink({ title: "Link 1", url: "http://one.com", userId: alice.id });
    createLink({ title: "Link 2", url: "http://two.com", userId: alice.id });
    createLink({ title: "Link 3", url: "http://three.com", userId: alice.id });

    const page1 = getUserLinks("alice", 2, 0);
    expect(page1).toHaveLength(2);
    expect(page1[0].title).toBeDefined();
    expect(page1[0].url).toBeDefined();
    expect(page1[0].score).toBeDefined();
    expect(page1[0].created_at).toBeDefined();

    const page2 = getUserLinks("alice", 2, 2);
    expect(page2).toHaveLength(1);
  });
});

describe("getUserComments", () => {
  test("returns paginated comments by user", () => {
    const alice = createUser({ username: "alice", email: "alice@test.com", passwordHash: "hash123" });
    const link = createLink({ title: "Link", url: "http://example.com", userId: alice.id });

    createComment({ body: "Comment 1", userId: alice.id, linkId: link.id });
    createComment({ body: "Comment 2", userId: alice.id, linkId: link.id });
    createComment({ body: "Comment 3", userId: alice.id, linkId: link.id });

    const page1 = getUserComments("alice", 2, 0);
    expect(page1).toHaveLength(2);
    expect(page1[0].body).toBeDefined();
    expect(page1[0].link_id).toBeDefined();
    expect(page1[0].score).toBeDefined();
    expect(page1[0].created_at).toBeDefined();

    const page2 = getUserComments("alice", 2, 2);
    expect(page2).toHaveLength(1);
  });
});

describe("updateUserBio", () => {
  test("updates the user's bio text", () => {
    createUser({ username: "alice", email: "alice@test.com", passwordHash: "hash123" });

    updateUserBio("alice", "Hello, I'm Alice!");

    const profile = getUserProfile("alice");
    expect(profile!.bio).toBe("Hello, I'm Alice!");
  });

  test("with empty string clears the bio", () => {
    createUser({ username: "alice", email: "alice@test.com", passwordHash: "hash123" });

    updateUserBio("alice", "Some bio");
    updateUserBio("alice", "");

    const profile = getUserProfile("alice");
    expect(profile!.bio).toBe("");
  });
});
