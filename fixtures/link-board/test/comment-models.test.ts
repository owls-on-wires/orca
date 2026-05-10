import { describe, test, expect, beforeEach } from "bun:test";
import {
  resetDb,
  createUser,
  createLink,
  createComment,
  getCommentsByLinkId,
  getCommentById,
  voteOnComment,
  removeCommentVote,
  softDeleteComment,
} from "../src/db";

let alice: { id: number };
let bob: { id: number };
let link: { id: number };

beforeEach(() => {
  resetDb();
  alice = createUser({
    username: "alice",
    email: "alice@test.com",
    passwordHash: "hash",
  });
  bob = createUser({
    username: "bob",
    email: "bob@test.com",
    passwordHash: "hash",
  });
  link = createLink({ title: "Test", url: "http://test.com", userId: alice.id });
});

describe("createComment", () => {
  test("creates a comment on a link and returns it with expected fields", () => {
    const comment = createComment({
      body: "Hello world",
      userId: alice.id,
      linkId: link.id,
    });

    expect(comment.id).toBeDefined();
    expect(comment.body).toBe("Hello world");
    expect(comment.user_id).toBe(alice.id);
    expect(comment.link_id).toBe(link.id);
    expect(comment.parent_id).toBeNull();
    expect(comment.created_at).toBeDefined();
  });

  test("creates a reply to another comment with parent_id", () => {
    const parent = createComment({
      body: "Parent",
      userId: alice.id,
      linkId: link.id,
    });

    const reply = createComment({
      body: "Reply",
      userId: bob.id,
      linkId: link.id,
      parentId: parent.id,
    });

    expect(reply.parent_id).toBe(parent.id);
    expect(reply.link_id).toBe(link.id);
  });
});

describe("getCommentsByLinkId", () => {
  test("returns flat list of comments with author info, score, and vote fields", () => {
    createComment({ body: "First", userId: alice.id, linkId: link.id });
    createComment({ body: "Second", userId: bob.id, linkId: link.id });

    const comments = getCommentsByLinkId(link.id, alice.id);

    expect(comments).toHaveLength(2);
    expect(comments[0].username).toBe("alice");
    expect(comments[0].score).toBe(0);
    expect(comments[0].upvotes).toBe(0);
    expect(comments[0].downvotes).toBe(0);
    expect(comments[0].current_user_vote).toBe(0);
    expect(comments[1].username).toBe("bob");
  });

  test("returns nested tree structure with replies array", () => {
    const top = createComment({
      body: "Top level",
      userId: alice.id,
      linkId: link.id,
    });
    const mid = createComment({
      body: "Reply to top",
      userId: bob.id,
      linkId: link.id,
      parentId: top.id,
    });
    const deep = createComment({
      body: "Reply to reply",
      userId: alice.id,
      linkId: link.id,
      parentId: mid.id,
    });

    const comments = getCommentsByLinkId(link.id, alice.id);

    // Top-level array should only contain root comments
    expect(comments).toHaveLength(1);
    expect(comments[0].body).toBe("Top level");

    // First-level reply
    expect(comments[0].replies).toHaveLength(1);
    expect(comments[0].replies[0].body).toBe("Reply to top");

    // Second-level reply (nested inside mid)
    expect(comments[0].replies[0].replies).toHaveLength(1);
    expect(comments[0].replies[0].replies[0].body).toBe("Reply to reply");
  });
});

describe("getCommentById", () => {
  test("returns a single comment with vote info", () => {
    const comment = createComment({
      body: "Test comment",
      userId: alice.id,
      linkId: link.id,
    });

    voteOnComment({ userId: bob.id, commentId: comment.id, direction: 1 });

    const result = getCommentById(comment.id, alice.id);
    expect(result).not.toBeNull();
    expect(result!.id).toBe(comment.id);
    expect(result!.body).toBe("Test comment");
    expect(result!.upvotes).toBe(1);
    expect(result!.score).toBe(1);
    expect(result!.current_user_vote).toBe(0);
  });

  test("returns null for non-existent comment", () => {
    const result = getCommentById(99999, alice.id);
    expect(result).toBeNull();
  });
});

describe("voteOnComment", () => {
  test("upvote increases score", () => {
    const comment = createComment({
      body: "Vote me",
      userId: alice.id,
      linkId: link.id,
    });

    voteOnComment({ userId: bob.id, commentId: comment.id, direction: 1 });

    const result = getCommentById(comment.id, bob.id);
    expect(result!.upvotes).toBe(1);
    expect(result!.score).toBe(1);
    expect(result!.current_user_vote).toBe(1);
  });

  test("downvote decreases score", () => {
    const comment = createComment({
      body: "Vote me",
      userId: alice.id,
      linkId: link.id,
    });

    voteOnComment({ userId: bob.id, commentId: comment.id, direction: -1 });

    const result = getCommentById(comment.id, bob.id);
    expect(result!.downvotes).toBe(1);
    expect(result!.score).toBe(-1);
    expect(result!.current_user_vote).toBe(-1);
  });

  test("changing vote from up to down updates correctly", () => {
    const comment = createComment({
      body: "Vote me",
      userId: alice.id,
      linkId: link.id,
    });

    voteOnComment({ userId: bob.id, commentId: comment.id, direction: 1 });
    voteOnComment({ userId: bob.id, commentId: comment.id, direction: -1 });

    const result = getCommentById(comment.id, bob.id);
    expect(result!.upvotes).toBe(0);
    expect(result!.downvotes).toBe(1);
    expect(result!.score).toBe(-1);
    expect(result!.current_user_vote).toBe(-1);
  });
});

describe("removeCommentVote", () => {
  test("removes a vote from a comment", () => {
    const comment = createComment({
      body: "Vote me",
      userId: alice.id,
      linkId: link.id,
    });

    voteOnComment({ userId: bob.id, commentId: comment.id, direction: 1 });
    removeCommentVote({ userId: bob.id, commentId: comment.id });

    const result = getCommentById(comment.id, bob.id);
    expect(result!.upvotes).toBe(0);
    expect(result!.score).toBe(0);
    expect(result!.current_user_vote).toBe(0);
  });
});

describe("softDeleteComment", () => {
  test("sets body to '[deleted]' but keeps the row for reply integrity", () => {
    const comment = createComment({
      body: "Delete me",
      userId: alice.id,
      linkId: link.id,
    });

    // Add a reply so we can verify the parent row persists
    createComment({
      body: "Reply",
      userId: bob.id,
      linkId: link.id,
      parentId: comment.id,
    });

    softDeleteComment(comment.id);

    const result = getCommentById(comment.id, alice.id);
    expect(result).not.toBeNull();
    expect(result!.body).toBe("[deleted]");
  });

  test("returns the updated comment with body set to '[deleted]'", () => {
    const comment = createComment({
      body: "Delete me",
      userId: alice.id,
      linkId: link.id,
    });

    const deleted = softDeleteComment(comment.id);
    expect(deleted.body).toBe("[deleted]");
    expect(deleted.id).toBe(comment.id);
  });
});
