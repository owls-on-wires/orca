import { describe, it, expect, beforeEach } from "bun:test";
import { resetDb } from "../src/db";
import { createUser } from "../src/db";
import { createLink, getLinks, getLinkById, countLinks, voteOnLink, removeVote, isUserBanned } from "../src/db";
import { Database } from "bun:sqlite";

beforeEach(() => resetDb());

function makeUser(suffix = "a") {
  return createUser({ username: `user_${suffix}`, email: `${suffix}@example.com`, passwordHash: "hash" });
}

describe("createLink", () => {
  it("creates a link and returns object with id, title, url, user_id, created_at", () => {
    const user = makeUser();
    const link = createLink({ title: "Hello", url: "https://example.com", userId: user.id });
    expect(typeof link.id).toBe("number");
    expect(link.title).toBe("Hello");
    expect(link.url).toBe("https://example.com");
    expect(link.user_id).toBe(user.id);
    expect(typeof link.created_at).toBe("string");
  });
});

describe("getLinks", () => {
  it("returns empty array when no links exist", () => {
    const result = getLinks({});
    expect(result).toEqual([]);
  });

  it("returns links after creation and includes score field defaulting to 0", () => {
    const user = makeUser();
    createLink({ title: "A", url: "https://a.com", userId: user.id });
    const result = getLinks({});
    expect(result.length).toBe(1);
    expect(result[0].score).toBe(0);
  });

  it("sort=newest returns most recent first", async () => {
    const user = makeUser();
    createLink({ title: "First", url: "https://first.com", userId: user.id });
    // Small delay so created_at differs
    await new Promise((r) => setTimeout(r, 10));
    createLink({ title: "Second", url: "https://second.com", userId: user.id });
    const result = getLinks({ sort: "newest" });
    expect(result[0].title).toBe("Second");
    expect(result[1].title).toBe("First");
  });

  it("sort=top returns highest score first", () => {
    const user = makeUser();
    const user2 = makeUser("b");
    const linkA = createLink({ title: "Low", url: "https://low.com", userId: user.id });
    const linkB = createLink({ title: "High", url: "https://high.com", userId: user.id });
    voteOnLink(linkB.id, user2.id, "up");
    const result = getLinks({ sort: "top" });
    expect(result[0].title).toBe("High");
    expect(result[1].title).toBe("Low");
  });

  it("limit/offset pagination works", () => {
    const user = makeUser();
    for (let i = 1; i <= 5; i++) {
      createLink({ title: `Link ${i}`, url: `https://link${i}.com`, userId: user.id });
    }
    const page1 = getLinks({ limit: 2, offset: 0 });
    const page2 = getLinks({ limit: 2, offset: 2 });
    expect(page1.length).toBe(2);
    expect(page2.length).toBe(2);
    expect(page1[0].title).not.toBe(page2[0].title);
  });
});

describe("getLinkById", () => {
  it("returns the link for a valid id", () => {
    const user = makeUser();
    const link = createLink({ title: "Test", url: "https://test.com", userId: user.id });
    const found = getLinkById(link.id);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(link.id);
  });

  it("returns null for a missing id", () => {
    expect(getLinkById(99999)).toBeNull();
  });
});

describe("countLinks", () => {
  it("returns correct count of links", () => {
    const user = makeUser();
    expect(countLinks()).toBe(0);
    createLink({ title: "A", url: "https://a.com", userId: user.id });
    createLink({ title: "B", url: "https://b.com", userId: user.id });
    expect(countLinks()).toBe(2);
  });
});

describe("voteOnLink", () => {
  it("upvote increases score by 1", () => {
    const user = makeUser();
    const voter = makeUser("b");
    const link = createLink({ title: "X", url: "https://x.com", userId: user.id });
    voteOnLink(link.id, voter.id, "up");
    const found = getLinkById(link.id);
    expect(found!.score).toBe(1);
  });

  it("downvote decreases score by 1", () => {
    const user = makeUser();
    const voter = makeUser("b");
    const link = createLink({ title: "X", url: "https://x.com", userId: user.id });
    voteOnLink(link.id, voter.id, "down");
    const found = getLinkById(link.id);
    expect(found!.score).toBe(-1);
  });

  it("changing vote from upvote to downvote updates score correctly", () => {
    const user = makeUser();
    const voter = makeUser("b");
    const link = createLink({ title: "X", url: "https://x.com", userId: user.id });
    voteOnLink(link.id, voter.id, "up");
    voteOnLink(link.id, voter.id, "down");
    const found = getLinkById(link.id);
    expect(found!.score).toBe(-1);
  });

  it("getLinkById returns user_vote field with direction after voting", () => {
    const user = makeUser();
    const voter = makeUser("b");
    const link = createLink({ title: "X", url: "https://x.com", userId: user.id });
    voteOnLink(link.id, voter.id, "up");
    const found = getLinkById(link.id, voter.id);
    expect(found!.user_vote).toBe("up");
  });
});

describe("removeVote", () => {
  it("removes vote and score returns to 0", () => {
    const user = makeUser();
    const voter = makeUser("b");
    const link = createLink({ title: "X", url: "https://x.com", userId: user.id });
    voteOnLink(link.id, voter.id, "up");
    removeVote(link.id, voter.id);
    const found = getLinkById(link.id);
    expect(found!.score).toBe(0);
  });
});

describe("isUserBanned", () => {
  it("returns false for a normal user", () => {
    const user = makeUser();
    expect(isUserBanned(user.id)).toBe(false);
  });

  it("returns true for a banned user (set via direct db write)", () => {
    const user = makeUser();
    const rawDb = new Database("link-board.db");
    rawDb.run("UPDATE users SET is_banned = 1 WHERE id = ?", [user.id]);
    rawDb.close();
    expect(isUserBanned(user.id)).toBe(true);
  });
});
