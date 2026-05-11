import { createUser, getUserByEmail, getUserById, getUserByUsername, createLink, getLinks, getLinkById, countLinks, voteOnLink, removeVote, createComment, getCommentsByLinkId, getCommentById, voteOnComment, removeCommentVote, softDeleteComment, getUserProfile, getUserLinks, getUserComments, updateUserBio, searchContent, countSearchContent, flagContent, getFlaggedContent, setUserBanned, isUserBanned, adminDeleteLink, adminDeleteComment } from "./db";
import { hashPassword, verifyPassword, signJWT, verifyJWT } from "./auth";

function getAuthUser(req: Request): { userId: number } | null {
  const auth = req.headers.get("authorization");
  if (!auth || !auth.startsWith("Bearer ")) return null;
  return verifyJWT(auth.slice(7));
}

function requireAuth(req: Request): { userId: number } | Response {
  const user = getAuthUser(req);
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  return user;
}

function userResponse(user: { id: number; username: string; email: string; is_admin: number; created_at: string }) {
  return { id: user.id, username: user.username, email: user.email, is_admin: user.is_admin, created_at: user.created_at };
}

function requireAdmin(req: Request): { userId: number } | Response {
  const auth = requireAuth(req);
  if (auth instanceof Response) return auth;
  const user = getUserById(auth.userId);
  if (!user || !user.is_admin) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }
  return auth;
}

function requireNotBanned(req: Request): { userId: number } | Response {
  const auth = requireAuth(req);
  if (auth instanceof Response) return auth;
  if (isUserBanned(auth.userId)) {
    return Response.json({ error: "Banned" }, { status: 403 });
  }
  return auth;
}

const server = Bun.serve({
  port: 3458,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/health" && req.method === "GET") {
      return Response.json({ status: "ok" });
    }

    if (url.pathname === "/register" && req.method === "POST") {
      const body = await req.json();
      const { username, email, password } = body;

      if (!username || !email || !password) {
        return Response.json({ error: "Missing required fields" }, { status: 400 });
      }

      const passwordHash = await hashPassword(password);

      try {
        const user = createUser({ username, email, passwordHash });
        const token = signJWT({ userId: user.id });
        return Response.json({ user: userResponse(user), token }, { status: 201 });
      } catch (err: any) {
        const msg: string = err.message ?? "";
        if (msg.includes("UNIQUE constraint failed: users.username")) {
          return Response.json({ error: "Username already taken" }, { status: 409 });
        }
        if (msg.includes("UNIQUE constraint failed: users.email")) {
          return Response.json({ error: "Email already taken" }, { status: 409 });
        }
        throw err;
      }
    }

    if (url.pathname === "/login" && req.method === "POST") {
      const body = await req.json();
      const { email, password } = body;

      const user = getUserByEmail(email);
      if (!user) {
        return Response.json({ error: "User not found" }, { status: 404 });
      }

      const valid = await verifyPassword(password, user.password_hash);
      if (!valid) {
        return Response.json({ error: "Invalid password" }, { status: 401 });
      }

      const token = signJWT({ userId: user.id });
      return Response.json({ user: userResponse(user), token });
    }

    if (url.pathname === "/me" && req.method === "GET") {
      const auth = requireAuth(req);
      if (auth instanceof Response) return auth;

      const user = getUserById(auth.userId);
      if (!user) {
        return Response.json({ error: "User not found" }, { status: 404 });
      }

      return Response.json({ user: userResponse(user) });
    }

    // POST /links
    if (url.pathname === "/links" && req.method === "POST") {
      const body = await req.json();
      const { title, url: linkUrl } = body;
      if (!title || !linkUrl) {
        return Response.json({ error: "Missing required fields" }, { status: 400 });
      }

      const auth = requireNotBanned(req);
      if (auth instanceof Response) return auth;

      const link = createLink({ title, url: linkUrl, userId: auth.userId });
      return Response.json({ link }, { status: 201 });
    }

    // GET /links
    if (url.pathname === "/links" && req.method === "GET") {
      const sort = (url.searchParams.get("sort") ?? "newest") as "newest" | "top" | "controversial";
      const limit = parseInt(url.searchParams.get("limit") ?? "20", 10);
      const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);
      const auth = getAuthUser(req);

      const links = getLinks({ sort, limit, offset, userId: auth?.userId });
      const total = countLinks();
      return Response.json({ links, total });
    }

    // Match /links/:id/vote and /links/:id
    const linkVoteMatch = url.pathname.match(/^\/links\/(\d+)\/vote$/);
    const linkIdMatch = !linkVoteMatch && url.pathname.match(/^\/links\/(\d+)$/);

    // POST /links/:id/vote
    if (linkVoteMatch && req.method === "POST") {
      const auth = requireNotBanned(req);
      if (auth instanceof Response) return auth;

      const linkId = parseInt(linkVoteMatch[1], 10);
      const body = await req.json();
      const direction = body.value as 1 | -1;

      voteOnLink({ userId: auth.userId, linkId, direction });
      const link = getLinkById(linkId, auth.userId);
      return Response.json({ link });
    }

    // DELETE /links/:id/vote
    if (linkVoteMatch && req.method === "DELETE") {
      const auth = requireAuth(req);
      if (auth instanceof Response) return auth;

      const linkId = parseInt(linkVoteMatch[1], 10);
      removeVote({ userId: auth.userId, linkId });
      const link = getLinkById(linkId, auth.userId);
      return Response.json({ link });
    }

    // GET /links/:id
    if (linkIdMatch && req.method === "GET") {
      const linkId = parseInt(linkIdMatch[1], 10);
      const auth = getAuthUser(req);
      const link = getLinkById(linkId, auth?.userId);
      if (!link) {
        return Response.json({ error: "Not found" }, { status: 404 });
      }
      return Response.json({ link });
    }

    // Match /links/:id/comments
    const linkCommentsMatch = url.pathname.match(/^\/links\/(\d+)\/comments$/);

    // POST /links/:id/comments
    if (linkCommentsMatch && req.method === "POST") {
      const linkId = parseInt(linkCommentsMatch[1], 10);
      const body = await req.json();
      if (!body.body) {
        return Response.json({ error: "Missing required fields" }, { status: 400 });
      }

      const auth = requireNotBanned(req);
      if (auth instanceof Response) return auth;

      const comment = createComment({ body: body.body, userId: auth.userId, linkId, parentId: body.parent_id });
      return Response.json({ comment }, { status: 201 });
    }

    // GET /links/:id/comments
    if (linkCommentsMatch && req.method === "GET") {
      const linkId = parseInt(linkCommentsMatch[1], 10);
      const auth = getAuthUser(req);
      const comments = getCommentsByLinkId(linkId, auth?.userId);
      return Response.json({ comments });
    }

    // Match /comments/:id/vote
    const commentVoteMatch = url.pathname.match(/^\/comments\/(\d+)\/vote$/);

    // POST /comments/:id/vote
    if (commentVoteMatch && req.method === "POST") {
      const auth = requireAuth(req);
      if (auth instanceof Response) return auth;

      const commentId = parseInt(commentVoteMatch[1], 10);
      const body = await req.json();
      voteOnComment({ userId: auth.userId, commentId, direction: body.value });
      const comment = getCommentById(commentId, auth.userId);
      return Response.json({ comment });
    }

    // DELETE /comments/:id/vote
    if (commentVoteMatch && req.method === "DELETE") {
      const auth = requireAuth(req);
      if (auth instanceof Response) return auth;

      const commentId = parseInt(commentVoteMatch[1], 10);
      removeCommentVote({ userId: auth.userId, commentId });
      const comment = getCommentById(commentId, auth.userId);
      return Response.json({ comment });
    }

    // Match /comments/:id
    const commentIdMatch = !commentVoteMatch && url.pathname.match(/^\/comments\/(\d+)$/);

    // DELETE /comments/:id
    if (commentIdMatch && req.method === "DELETE") {
      const auth = requireAuth(req);
      if (auth instanceof Response) return auth;

      const commentId = parseInt(commentIdMatch[1], 10);
      const existing = getCommentById(commentId);
      if (!existing) {
        return Response.json({ error: "Not found" }, { status: 404 });
      }
      if (existing.user_id !== auth.userId) {
        return Response.json({ error: "Forbidden" }, { status: 403 });
      }

      const comment = softDeleteComment(commentId);
      return Response.json({ comment });
    }

    // Match /users/:username/links, /users/:username/comments, /users/:username
    const userLinksMatch = url.pathname.match(/^\/users\/([^\/]+)\/links$/);
    const userCommentsMatch = url.pathname.match(/^\/users\/([^\/]+)\/comments$/);
    const userProfileMatch = !userLinksMatch && !userCommentsMatch && url.pathname.match(/^\/users\/([^\/]+)$/);

    // GET /users/:username/links
    if (userLinksMatch && req.method === "GET") {
      const username = userLinksMatch[1];
      const limit = parseInt(url.searchParams.get("limit") ?? "20", 10);
      const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);
      const links = getUserLinks(username, limit, offset);
      return Response.json({ links });
    }

    // GET /users/:username/comments
    if (userCommentsMatch && req.method === "GET") {
      const username = userCommentsMatch[1];
      const limit = parseInt(url.searchParams.get("limit") ?? "20", 10);
      const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);
      const comments = getUserComments(username, limit, offset);
      return Response.json({ comments });
    }

    // GET /users/:username
    if (userProfileMatch && req.method === "GET") {
      const username = userProfileMatch[1];
      const profile = getUserProfile(username);
      if (!profile) {
        return Response.json({ error: "Not found" }, { status: 404 });
      }
      return Response.json({ profile });
    }

    // PATCH /users/:username
    if (userProfileMatch && req.method === "PATCH") {
      const auth = requireAuth(req);
      if (auth instanceof Response) return auth;

      const username = userProfileMatch[1];
      const user = getUserByUsername(username);
      if (!user || user.id !== auth.userId) {
        return Response.json({ error: "Forbidden" }, { status: 403 });
      }

      const body = await req.json();
      updateUserBio(username, body.bio);
      const profile = getUserProfile(username);
      return Response.json({ profile });
    }

    // GET /search
    if (url.pathname === "/search" && req.method === "GET") {
      const q = url.searchParams.get("q");
      if (!q) {
        return Response.json({ error: "Missing query parameter" }, { status: 400 });
      }
      const limit = parseInt(url.searchParams.get("limit") ?? "20", 10);
      const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);
      const results = searchContent(q, limit, offset);
      const total = countSearchContent(q);
      return Response.json({ results, total });
    }

    // --- Flagging ---

    // POST /links/:id/flag
    const linkFlagMatch = url.pathname.match(/^\/links\/(\d+)\/flag$/);
    if (linkFlagMatch && req.method === "POST") {
      const auth = requireAuth(req);
      if (auth instanceof Response) return auth;

      const linkId = parseInt(linkFlagMatch[1], 10);
      const body = await req.json().catch(() => ({}));
      try {
        const flag = flagContent({ userId: auth.userId, targetType: "link", targetId: linkId, reason: body.reason });
        return Response.json({ flag }, { status: 201 });
      } catch (err: any) {
        if (err.message?.includes("UNIQUE constraint failed")) {
          return Response.json({ error: "Already flagged" }, { status: 409 });
        }
        throw err;
      }
    }

    // POST /comments/:id/flag
    const commentFlagMatch = url.pathname.match(/^\/comments\/(\d+)\/flag$/);
    if (commentFlagMatch && req.method === "POST") {
      const auth = requireAuth(req);
      if (auth instanceof Response) return auth;

      const commentId = parseInt(commentFlagMatch[1], 10);
      const body = await req.json().catch(() => ({}));
      try {
        const flag = flagContent({ userId: auth.userId, targetType: "comment", targetId: commentId, reason: body.reason });
        return Response.json({ flag }, { status: 201 });
      } catch (err: any) {
        if (err.message?.includes("UNIQUE constraint failed")) {
          return Response.json({ error: "Already flagged" }, { status: 409 });
        }
        throw err;
      }
    }

    // --- Admin endpoints ---

    // GET /moderation/flagged
    if (url.pathname === "/moderation/flagged" && req.method === "GET") {
      const auth = requireAdmin(req);
      if (auth instanceof Response) return auth;

      const flagged = getFlaggedContent();
      return Response.json({ flagged });
    }

    // DELETE /admin/links/:id
    const adminLinkMatch = url.pathname.match(/^\/admin\/links\/(\d+)$/);
    if (adminLinkMatch && req.method === "DELETE") {
      const auth = requireAdmin(req);
      if (auth instanceof Response) return auth;

      const linkId = parseInt(adminLinkMatch[1], 10);
      adminDeleteLink(linkId);
      return Response.json({ success: true });
    }

    // DELETE /admin/comments/:id
    const adminCommentMatch = url.pathname.match(/^\/admin\/comments\/(\d+)$/);
    if (adminCommentMatch && req.method === "DELETE") {
      const auth = requireAdmin(req);
      if (auth instanceof Response) return auth;

      const commentId = parseInt(adminCommentMatch[1], 10);
      adminDeleteComment(commentId);
      return Response.json({ success: true });
    }

    // POST /admin/users/:id/ban
    const banMatch = url.pathname.match(/^\/admin\/users\/(\d+)\/ban$/);
    if (banMatch && req.method === "POST") {
      const auth = requireAdmin(req);
      if (auth instanceof Response) return auth;

      const targetUserId = parseInt(banMatch[1], 10);
      setUserBanned(targetUserId, true);
      return Response.json({ success: true });
    }

    // POST /admin/users/:id/unban
    const unbanMatch = url.pathname.match(/^\/admin\/users\/(\d+)\/unban$/);
    if (unbanMatch && req.method === "POST") {
      const auth = requireAdmin(req);
      if (auth instanceof Response) return auth;

      const targetUserId = parseInt(unbanMatch[1], 10);
      setUserBanned(targetUserId, false);
      return Response.json({ success: true });
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  },
});

console.log(`Link Board API running on port ${server.port}`);
