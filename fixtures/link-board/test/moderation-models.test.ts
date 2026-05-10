import { describe, test, expect, beforeEach } from "bun:test";
import {
  db,
  resetDb,
  createUser,
  createLink,
  createComment,
  voteOnLink,
  voteOnComment,
  getUserById,
  flagContent,
  getFlaggedContent,
  setUserBanned,
  isUserBanned,
  adminDeleteLink,
  adminDeleteComment,
  searchContent,
} from "../src/db";

beforeEach(() => resetDb());

describe("createUser admin logic", () => {
  test("first user gets is_admin=1", () => {
    const user = createUser({ username: "first", email: "first@test.com", passwordHash: "hash" });
    const fetched = getUserById(user.id);
    expect(fetched!.is_admin).toBe(1);
  });

  test("subsequent users get is_admin=0", () => {
    createUser({ username: "first", email: "first@test.com", passwordHash: "hash" });
    const second = createUser({ username: "second", email: "second@test.com", passwordHash: "hash" });
    const fetched = getUserById(second.id);
    expect(fetched!.is_admin).toBe(0);
  });
});

describe("getUserById includes moderation fields", () => {
  test("includes is_admin and is_banned fields", () => {
    const user = createUser({ username: "alice", email: "alice@test.com", passwordHash: "hash" });
    const fetched = getUserById(user.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.is_admin).toBeDefined();
    expect(fetched!.is_banned).toBeDefined();
    expect(fetched!.is_banned).toBe(0);
  });
});

describe("flagContent", () => {
  test("creates a flag and returns the flag row", () => {
    const user = createUser({ username: "alice", email: "alice@test.com", passwordHash: "hash" });
    const poster = createUser({ username: "bob", email: "bob@test.com", passwordHash: "hash" });
    const link = createLink({ title: "Bad Link", url: "http://bad.com", userId: poster.id });

    const flag = flagContent({
      userId: user.id,
      targetType: "link",
      targetId: link.id,
      reason: "spam",
    });

    expect(flag.id).toBeDefined();
    expect(flag.user_id).toBe(user.id);
    expect(flag.target_type).toBe("link");
    expect(flag.target_id).toBe(link.id);
    expect(flag.reason).toBe("spam");
    expect(flag.created_at).toBeDefined();
  });

  test("duplicate flag from same user on same target throws", () => {
    const user = createUser({ username: "alice", email: "alice@test.com", passwordHash: "hash" });
    const poster = createUser({ username: "bob", email: "bob@test.com", passwordHash: "hash" });
    const link = createLink({ title: "Bad Link", url: "http://bad.com", userId: poster.id });

    flagContent({ userId: user.id, targetType: "link", targetId: link.id, reason: "spam" });

    expect(() =>
      flagContent({ userId: user.id, targetType: "link", targetId: link.id, reason: "other reason" })
    ).toThrow();
  });
});

describe("getFlaggedContent", () => {
  test("returns all flags with target info ordered by newest first", () => {
    const flagger = createUser({ username: "alice", email: "alice@test.com", passwordHash: "hash" });
    const poster = createUser({ username: "bob", email: "bob@test.com", passwordHash: "hash" });
    const link = createLink({ title: "Bad Link", url: "http://bad.com", userId: poster.id });
    const comment = createComment({ body: "Bad comment", userId: poster.id, linkId: link.id });

    flagContent({ userId: flagger.id, targetType: "link", targetId: link.id, reason: "spam" });
    flagContent({ userId: flagger.id, targetType: "comment", targetId: comment.id, reason: "offensive" });

    const flags = getFlaggedContent();

    expect(flags.length).toBe(2);
    // Newest first
    expect(flags[0].target_type).toBe("comment");
    expect(flags[0].reason).toBe("offensive");
    expect(flags[1].target_type).toBe("link");
    expect(flags[1].reason).toBe("spam");
    // Target info included
    expect(flags[1].title).toBe("Bad Link");
    expect(flags[1].url).toBe("http://bad.com");
    expect(flags[0].body).toBe("Bad comment");
  });

  test("returns empty array when no flags exist", () => {
    const flags = getFlaggedContent();
    expect(flags).toEqual([]);
  });
});

describe("setUserBanned / isUserBanned", () => {
  test("setUserBanned sets is_banned", () => {
    const user = createUser({ username: "alice", email: "alice@test.com", passwordHash: "hash" });
    setUserBanned(user.id, true);
    const fetched = getUserById(user.id);
    expect(fetched!.is_banned).toBe(1);
  });

  test("getUserById after ban shows is_banned=1", () => {
    const user = createUser({ username: "alice", email: "alice@test.com", passwordHash: "hash" });
    setUserBanned(user.id, true);
    const fetched = getUserById(user.id);
    expect(fetched!.is_banned).toBe(1);
  });

  test("isUserBanned returns boolean", () => {
    const user = createUser({ username: "alice", email: "alice@test.com", passwordHash: "hash" });
    expect(isUserBanned(user.id)).toBe(false);
    setUserBanned(user.id, true);
    expect(isUserBanned(user.id)).toBe(true);
    setUserBanned(user.id, false);
    expect(isUserBanned(user.id)).toBe(false);
  });
});

describe("adminDeleteLink", () => {
  test("hard deletes a link and its votes", () => {
    const user = createUser({ username: "alice", email: "alice@test.com", passwordHash: "hash" });
    const voter = createUser({ username: "bob", email: "bob@test.com", passwordHash: "hash" });
    const link = createLink({ title: "Test", url: "http://test.com", userId: user.id });
    voteOnLink({ userId: voter.id, linkId: link.id, direction: 1 });

    adminDeleteLink(link.id);

    const row = db.prepare("SELECT * FROM links WHERE id = ?").get(link.id);
    expect(row).toBeNull();
    const votes = db.prepare("SELECT * FROM votes WHERE link_id = ?").all(link.id);
    expect(votes.length).toBe(0);
  });
});

describe("adminDeleteComment", () => {
  test("hard deletes a comment and its votes", () => {
    const user = createUser({ username: "alice", email: "alice@test.com", passwordHash: "hash" });
    const voter = createUser({ username: "bob", email: "bob@test.com", passwordHash: "hash" });
    const link = createLink({ title: "Test", url: "http://test.com", userId: user.id });
    const comment = createComment({ body: "To delete", userId: user.id, linkId: link.id });
    voteOnComment({ userId: voter.id, commentId: comment.id, direction: 1 });

    adminDeleteComment(comment.id);

    const row = db.prepare("SELECT * FROM comments WHERE id = ?").get(comment.id);
    expect(row).toBeNull();
    const votes = db.prepare("SELECT * FROM comment_votes WHERE comment_id = ?").all(comment.id);
    expect(votes.length).toBe(0);
  });
});

describe("searchContent", () => {
  test("searches link titles/URLs and comment bodies using LIKE", () => {
    const user = createUser({ username: "alice", email: "alice@test.com", passwordHash: "hash" });
    createLink({ title: "Rust Programming", url: "http://rust-lang.org", userId: user.id });
    createLink({ title: "Go Language", url: "http://golang.org", userId: user.id });
    const link = createLink({ title: "Other", url: "http://other.com", userId: user.id });
    createComment({ body: "I love Rust!", userId: user.id, linkId: link.id });

    const results = searchContent("rust", 10, 0);

    expect(results.length).toBeGreaterThanOrEqual(2);
    const types = results.map((r: any) => r.type);
    expect(types).toContain("link");
    expect(types).toContain("comment");
  });

  test("respects limit and offset", () => {
    const user = createUser({ username: "alice", email: "alice@test.com", passwordHash: "hash" });
    for (let i = 0; i < 5; i++) {
      createLink({ title: `Test Link ${i}`, url: `http://test${i}.com`, userId: user.id });
    }

    const page1 = searchContent("test", 2, 0);
    const page2 = searchContent("test", 2, 2);

    expect(page1.length).toBe(2);
    expect(page2.length).toBe(2);
  });

  test("returns results with type field", () => {
    const user = createUser({ username: "alice", email: "alice@test.com", passwordHash: "hash" });
    createLink({ title: "Searchable", url: "http://example.com", userId: user.id });

    const results = searchContent("searchable", 10, 0);
    expect(results.length).toBe(1);
    expect(results[0].type).toBe("link");
  });
});
