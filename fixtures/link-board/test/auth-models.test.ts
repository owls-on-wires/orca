import { describe, test, expect, beforeEach } from "bun:test";
import {
  createUser,
  getUserByEmail,
  getUserById,
  getUserByUsername,
  resetDb,
} from "../src/db";
import {
  hashPassword,
  verifyPassword,
  signJWT,
  verifyJWT,
} from "../src/auth";

beforeEach(() => resetDb());

describe("createUser", () => {
  test("creates a user with id, username, email, and created_at", () => {
    const user = createUser({
      username: "alice",
      email: "alice@example.com",
      passwordHash: "hashed123",
    });

    expect(user.id).toBeDefined();
    expect(user.username).toBe("alice");
    expect(user.email).toBe("alice@example.com");
    expect(user.created_at).toBeDefined();
  });

  test("throws on duplicate email", () => {
    createUser({
      username: "alice",
      email: "alice@example.com",
      passwordHash: "hashed123",
    });

    expect(() =>
      createUser({
        username: "bob",
        email: "alice@example.com",
        passwordHash: "hashed456",
      })
    ).toThrow();
  });

  test("throws on duplicate username", () => {
    createUser({
      username: "alice",
      email: "alice@example.com",
      passwordHash: "hashed123",
    });

    expect(() =>
      createUser({
        username: "alice",
        email: "bob@example.com",
        passwordHash: "hashed456",
      })
    ).toThrow();
  });
});

describe("getUserByEmail", () => {
  test("returns user when found by email", () => {
    createUser({
      username: "alice",
      email: "alice@example.com",
      passwordHash: "hashed123",
    });

    const user = getUserByEmail("alice@example.com");
    expect(user).not.toBeNull();
    expect(user!.email).toBe("alice@example.com");
    expect(user!.username).toBe("alice");
  });

  test("returns null when email not found", () => {
    const user = getUserByEmail("nobody@example.com");
    expect(user).toBeNull();
  });
});

describe("getUserById", () => {
  test("returns user when found by id", () => {
    const created = createUser({
      username: "alice",
      email: "alice@example.com",
      passwordHash: "hashed123",
    });

    const user = getUserById(created.id);
    expect(user).not.toBeNull();
    expect(user!.id).toBe(created.id);
    expect(user!.username).toBe("alice");
  });

  test("returns null when id not found", () => {
    const user = getUserById(99999);
    expect(user).toBeNull();
  });
});

describe("getUserByUsername", () => {
  test("returns user when found", () => {
    createUser({
      username: "alice",
      email: "alice@example.com",
      passwordHash: "hashed123",
    });

    const user = getUserByUsername("alice");
    expect(user).not.toBeNull();
    expect(user!.username).toBe("alice");
    expect(user!.email).toBe("alice@example.com");
  });
});

describe("hashPassword", () => {
  test("returns a non-empty string different from the input", async () => {
    const hash = await hashPassword("mypassword");
    expect(typeof hash).toBe("string");
    expect(hash.length).toBeGreaterThan(0);
    expect(hash).not.toBe("mypassword");
  });
});

describe("verifyPassword", () => {
  test("returns true for correct password, false for wrong password", async () => {
    const hash = await hashPassword("correct-password");
    expect(await verifyPassword("correct-password", hash)).toBe(true);
    expect(await verifyPassword("wrong-password", hash)).toBe(false);
  });
});

describe("signJWT", () => {
  test("returns a non-empty string token", () => {
    const token = signJWT({ userId: 1 });
    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThan(0);
  });
});

describe("verifyJWT", () => {
  test("returns object with userId matching what was signed", () => {
    const token = signJWT({ userId: 42 });
    const payload = verifyJWT(token);
    expect(payload).not.toBeNull();
    expect(payload!.userId).toBe(42);
  });

  test("returns null for a garbage token", () => {
    const payload = verifyJWT("this.is.garbage");
    expect(payload).toBeNull();
  });
});
