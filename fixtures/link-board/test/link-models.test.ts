import { describe, test, expect, beforeEach } from "bun:test";
import {
  createUser,
  createLink,
  getLinks,
  getLinkById,
  voteOnLink,
  removeVote,
  resetDb,
} from "../src/db";

let alice: { id: number };
let bob: { id: number };

beforeEach(() => {
  resetDb();
  alice = createUser({
    username: "alice",
    email: "alice@example.com",
    passwordHash: "hashed123",
  });
  bob = createUser({
    username: "bob",
    email: "bob@example.com",
    passwordHash: "hashed456",
  });
});

describe("createLink", () => {
  test("creates a link with title, url, user_id and returns it with id and created_at", () => {
    const link = createLink({
      title: "Example",
      url: "https://example.com",
      userId: alice.id,
    });

    expect(link.id).toBeDefined();
    expect(link.title).toBe("Example");
    expect(link.url).toBe("https://example.com");
    expect(link.user_id).toBe(alice.id);
    expect(link.created_at).toBeDefined();
  });
});

describe("getLinks", () => {
  test("newest - returns links sorted by created_at DESC, paginated", () => {
    const link1 = createLink({
      title: "First",
      url: "https://first.com",
      userId: alice.id,
    });
    const link2 = createLink({
      title: "Second",
      url: "https://second.com",
      userId: alice.id,
    });
    const link3 = createLink({
      title: "Third",
      url: "https://third.com",
      userId: alice.id,
    });

    const page1 = getLinks({ sort: "newest", limit: 2, offset: 0 });
    expect(page1).toHaveLength(2);
    expect(page1[0].id).toBe(link3.id);
    expect(page1[1].id).toBe(link2.id);

    const page2 = getLinks({ sort: "newest", limit: 2, offset: 2 });
    expect(page2).toHaveLength(1);
    expect(page2[0].id).toBe(link1.id);
  });

  test("top - returns links sorted by score DESC", () => {
    const link1 = createLink({
      title: "Unpopular",
      url: "https://unpopular.com",
      userId: alice.id,
    });
    const link2 = createLink({
      title: "Popular",
      url: "https://popular.com",
      userId: alice.id,
    });

    voteOnLink({ linkId: link2.id, userId: alice.id, direction: 1 });
    voteOnLink({ linkId: link2.id, userId: bob.id, direction: 1 });
    voteOnLink({ linkId: link1.id, userId: alice.id, direction: -1 });

    const links = getLinks({ sort: "top", limit: 10, offset: 0 });
    expect(links[0].id).toBe(link2.id);
    expect(links[1].id).toBe(link1.id);
  });

  test("includes vote counts with upvotes, downvotes, and score", () => {
    const link = createLink({
      title: "Voted",
      url: "https://voted.com",
      userId: alice.id,
    });

    voteOnLink({ linkId: link.id, userId: alice.id, direction: 1 });
    voteOnLink({ linkId: link.id, userId: bob.id, direction: -1 });

    const links = getLinks({ sort: "newest", limit: 10, offset: 0 });
    expect(links[0].upvotes).toBe(1);
    expect(links[0].downvotes).toBe(1);
    expect(links[0].score).toBe(0);
  });

  test("with userId param includes current_user_vote field", () => {
    const link = createLink({
      title: "Test",
      url: "https://test.com",
      userId: alice.id,
    });

    voteOnLink({ linkId: link.id, userId: alice.id, direction: 1 });

    const linksAsAlice = getLinks({
      sort: "newest",
      limit: 10,
      offset: 0,
      userId: alice.id,
    });
    expect(linksAsAlice[0].current_user_vote).toBe(1);

    const linksAsBob = getLinks({
      sort: "newest",
      limit: 10,
      offset: 0,
      userId: bob.id,
    });
    expect(linksAsBob[0].current_user_vote).toBe(0);
  });
});

describe("voteOnLink", () => {
  test("user can upvote or downvote a link", () => {
    const link = createLink({
      title: "Test",
      url: "https://test.com",
      userId: alice.id,
    });

    voteOnLink({ linkId: link.id, userId: alice.id, direction: 1 });

    const result = getLinkById(link.id);
    expect(result!.upvotes).toBe(1);
    expect(result!.downvotes).toBe(0);
    expect(result!.score).toBe(1);
  });

  test("voting again with same direction is idempotent", () => {
    const link = createLink({
      title: "Test",
      url: "https://test.com",
      userId: alice.id,
    });

    voteOnLink({ linkId: link.id, userId: alice.id, direction: 1 });
    voteOnLink({ linkId: link.id, userId: alice.id, direction: 1 });

    const result = getLinkById(link.id);
    expect(result!.upvotes).toBe(1);
    expect(result!.score).toBe(1);
  });

  test("changing vote direction updates the existing vote", () => {
    const link = createLink({
      title: "Test",
      url: "https://test.com",
      userId: alice.id,
    });

    voteOnLink({ linkId: link.id, userId: alice.id, direction: 1 });
    voteOnLink({ linkId: link.id, userId: alice.id, direction: -1 });

    const result = getLinkById(link.id);
    expect(result!.upvotes).toBe(0);
    expect(result!.downvotes).toBe(1);
    expect(result!.score).toBe(-1);
  });
});

describe("removeVote", () => {
  test("removes a user's vote from a link", () => {
    const link = createLink({
      title: "Test",
      url: "https://test.com",
      userId: alice.id,
    });

    voteOnLink({ linkId: link.id, userId: alice.id, direction: 1 });
    removeVote({ linkId: link.id, userId: alice.id });

    const result = getLinkById(link.id);
    expect(result!.upvotes).toBe(0);
    expect(result!.score).toBe(0);
  });
});

describe("getLinkById", () => {
  test("returns a single link with vote counts", () => {
    const link = createLink({
      title: "Test",
      url: "https://test.com",
      userId: alice.id,
    });

    voteOnLink({ linkId: link.id, userId: alice.id, direction: 1 });
    voteOnLink({ linkId: link.id, userId: bob.id, direction: 1 });

    const result = getLinkById(link.id);
    expect(result).not.toBeNull();
    expect(result!.id).toBe(link.id);
    expect(result!.title).toBe("Test");
    expect(result!.url).toBe("https://test.com");
    expect(result!.user_id).toBe(alice.id);
    expect(result!.upvotes).toBe(2);
    expect(result!.downvotes).toBe(0);
    expect(result!.score).toBe(2);
  });
});
