import { createHmac } from "crypto";

const SECRET = "link-board-secret";

function base64url(input: string): string {
  const b64 = Buffer.from(input).toString("base64");
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

export function hashPassword(password: string): string {
  return Bun.password.hashSync(password);
}

export function verifyPassword(password: string, hash: string): boolean {
  return Bun.password.verifySync(password, hash);
}

export function signJWT(payload: object): string {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = base64url(JSON.stringify(payload));
  const signing = `${header}.${body}`;
  const sig = createHmac("sha256", SECRET).update(signing).digest("base64url");
  return `${signing}.${sig}`;
}

export function verifyJWT(token: string): { userId: number } | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [header, body, sig] = parts;
    const signing = `${header}.${body}`;
    const expected = createHmac("sha256", SECRET).update(signing).digest("base64url");
    if (sig !== expected) return null;
    return JSON.parse(Buffer.from(body, "base64url").toString());
  } catch {
    return null;
  }
}
