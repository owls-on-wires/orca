# Link Board — Epics

A link-sharing platform (like Hacker News). Server-only REST API built
with Bun and SQLite. Complete each epic fully before moving to the next.

## Epic 1: Users & Auth

User registration and login with JWT authentication.

- Users register with username, email, password
- Passwords are hashed (use Bun.password.hash / Bun.password.verify)
- Login returns a JWT token (use a simple HMAC-SHA256 JWT — no external libraries)
- Protected routes verify the JWT via Authorization header
- GET /me returns the authenticated user's profile
- All subsequent epics assume auth is working — protected routes should
  reject unauthenticated requests with 401

## Epic 2: Links

Authenticated users can submit and browse links.

- Submit a link with title + URL (must be logged in)
- Each link belongs to a submitter (user)
- List links with sorting: newest (default), top (by score), controversial
- Score = upvotes minus downvotes
- Users can upvote or downvote a link (one vote per user per link)
- Changing vote (upvote → downvote) should work
- Removing a vote should work
- GET /links returns paginated results with vote counts and current user's vote

## Epic 3: Comments

Threaded comments on links.

- Authenticated users can comment on a link
- Comments can be replies to other comments (parent_id)
- GET /links/:id/comments returns a nested tree structure
- Users can vote on comments (same mechanics as link voting)
- Comments include author info, score, timestamp, reply count
- Deleting a comment soft-deletes it (content replaced with "[deleted]")

## Epic 4: Profiles & Karma

Public user profiles with karma and activity history.

- GET /users/:username returns public profile
- Karma = sum of all votes received on the user's links and comments
- Profile includes: username, karma, join date, link count, comment count
- GET /users/:username/links — paginated list of user's submitted links
- GET /users/:username/comments — paginated list of user's comments
- Users can update their own bio/about text

## Epic 5: Moderation & Search

Content moderation and full-text search.

- Any authenticated user can flag a link or comment
- GET /search?q=term searches across link titles, URLs, and comment text
  (case-insensitive, SQL LIKE)
- Search results are paginated and indicate whether result is a link or comment
- Admin role: first registered user is automatically admin
- Admin can delete any link or comment (hard delete)
- Admin can ban/unban users (banned users can't post or vote, get 403)
- GET /moderation/flagged returns flagged content for admins
