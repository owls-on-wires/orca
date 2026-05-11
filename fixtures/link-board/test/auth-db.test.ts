import { describe, test, expect, beforeEach } from "bun:test";
import { hashPassword, verifyPassword, signJWT, verifyJWT } from "../src/auth";
import { createUser, getUserByEmail, getUserById, getUserByUsername, resetDb } from "../src/db";

beforeEach(() => resetDb());

describe("hashPassword", () => {
  test("returns a string different from the input", () => {
    const hash = hashPassword("mysecret");
    expect(typeof hash).toBe("string");
    expect(hash).not.toBe("mysecret");
  });
});

describe("verifyPassword", () => {
  test("returns true for correct password", () => {
    const hash = hashPassword("correct");
    expect(verifyPassword("correct", hash)).toBe(true);
  });

  test("returns false for wrong password", () => {
    const hash = hashPassword("correct");
    expect(verifyPassword("wrong", hash)).toBe(false);
  });
});

describe("signJWT / verifyJWT", () => {
  test("signJWT returns a non-empty string token", () => {
    const token = signJWT({ userId: 1 });
    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThan(0);
  });

  test("verifyJWT returns the original payload for a valid token", () => {
    const token = signJWT({ userId: 1 });
    const payload = verifyJWT(token);
    expect(payload).not.toBeNull();
    expect(payload!.userId).toBe(1);
  });

  test("verifyJWT returns null for an invalid/tampered token", () => {
    const token = signJWT({ userId: 1 });
    const tampered = token.slice(0, -5) + "XXXXX";
    expect(verifyJWT(tampered)).toBeNull();
  });
});

describe("createUser", () => {
  test("returns object with id, username, email, is_admin, created_at", () => {
    const user = createUser({ username: "alice", email: "alice@example.com", passwordHash: "hash1" });
    expect(typeof user.id).toBe("number");
    expect(user.username).toBe("alice");
    expect(user.email).toBe("alice@example.com");
    expect("is_admin" in user).toBe(true);
    expect("created_at" in user).toBe(true);
  });

  test("first registered user has is_admin === 1", () => {
    const user = createUser({ username: "admin", email: "admin@example.com", passwordHash: "hash1" });
    expect(user.is_admin).toBe(1);
  });

  test("second registered user has is_admin === 0", () => {
    createUser({ username: "admin", email: "admin@example.com", passwordHash: "hash1" });
    const user = createUser({ username: "bob", email: "bob@example.com", passwordHash: "hash2" });
    expect(user.is_admin).toBe(0);
  });

  test("throws on duplicate username", () => {
    createUser({ username: "alice", email: "alice@example.com", passwordHash: "hash1" });
    expect(() => createUser({ username: "alice", email: "other@example.com", passwordHash: "hash2" })).toThrow();
  });

  test("throws on duplicate email", () => {
    createUser({ username: "alice", email: "alice@example.com", passwordHash: "hash1" });
    expect(() => createUser({ username: "other", email: "alice@example.com", passwordHash: "hash2" })).toThrow();
  });
});

describe("getUserByEmail", () => {
  test("returns user for known email", () => {
    createUser({ username: "alice", email: "alice@example.com", passwordHash: "hash1" });
    const user = getUserByEmail("alice@example.com");
    expect(user).not.toBeNull();
    expect(user!.username).toBe("alice");
  });

  test("returns null for unknown email", () => {
    expect(getUserByEmail("nobody@example.com")).toBeNull();
  });
});

describe("getUserById", () => {
  test("returns user for known id", () => {
    const created = createUser({ username: "alice", email: "alice@example.com", passwordHash: "hash1" });
    const user = getUserById(created.id);
    expect(user).not.toBeNull();
    expect(user!.id).toBe(created.id);
  });

  test("returns null for unknown id", () => {
    expect(getUserById(99999)).toBeNull();
  });
});

describe("getUserByUsername", () => {
  test("returns user for known username", () => {
    createUser({ username: "alice", email: "alice@example.com", passwordHash: "hash1" });
    const user = getUserByUsername("alice");
    expect(user).not.toBeNull();
    expect(user!.username).toBe("alice");
  });

  test("returns null for unknown username", () => {
    expect(getUserByUsername("nobody")).toBeNull();
  });
});
