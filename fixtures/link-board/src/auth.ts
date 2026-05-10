const JWT_SECRET = process.env.JWT_SECRET ?? "dev-secret-change-me";
const JWT_EXPIRY_SECONDS = 7 * 24 * 60 * 60; // 7 days

export async function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password);
}

export async function verifyPassword(
  password: string,
  hash: string
): Promise<boolean> {
  return Bun.password.verify(password, hash);
}

function base64url(data: Uint8Array | string): string {
  const str =
    typeof data === "string"
      ? btoa(data)
      : btoa(String.fromCharCode(...data));
  return str.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecode(str: string): string {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/");
  return atob(padded);
}

let cryptoKey: CryptoKey | null = null;

async function getKey(): Promise<CryptoKey> {
  if (cryptoKey) return cryptoKey;
  const enc = new TextEncoder();
  cryptoKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(JWT_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
  return cryptoKey;
}

// Pre-initialize the key so signJWT can be synchronous
const keyPromise = getKey();

export function signJWT(payload: { userId: number }): string {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const exp = Math.floor(Date.now() / 1000) + JWT_EXPIRY_SECONDS;
  const body = base64url(JSON.stringify({ ...payload, exp }));
  const data = `${header}.${body}`;

  // Synchronous HMAC using Bun's crypto
  const enc = new TextEncoder();
  const hmac = new Bun.CryptoHasher("sha256", enc.encode(JWT_SECRET));
  hmac.update(enc.encode(data));
  const sig = base64url(new Uint8Array(hmac.digest() as ArrayBuffer));

  return `${data}.${sig}`;
}

export function verifyJWT(token: string): { userId: number } | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;

    const [header, body, sig] = parts;
    const data = `${header}.${body}`;

    const enc = new TextEncoder();
    const hmac = new Bun.CryptoHasher("sha256", enc.encode(JWT_SECRET));
    hmac.update(enc.encode(data));
    const expected = base64url(new Uint8Array(hmac.digest() as ArrayBuffer));

    if (sig !== expected) return null;

    const payload = JSON.parse(base64urlDecode(body));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;

    return { userId: payload.userId };
  } catch {
    return null;
  }
}
