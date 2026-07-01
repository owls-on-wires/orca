# Bookmark Manager API — Capability Rubric (Judge-Only)

This checklist is for the LLM judge. It is **hidden from the builder.** Grade the
running software's observable behavior, not its source code. Every FUNCTIONAL and
ROBUST claim must be proven with an actual request against the live service and
the real response it returns — never by reading code.

The API's exact shape (routes, field names, status-code choices) is the builder's
decision. Judge **behavior and outcomes**, not adherence to any specific contract.
Where this rubric names a field or status code, treat it as *an* acceptable
example of the behavior, not *the required* spelling. Look for the capability's
effect however the API chooses to expose it.

For each capability, grade three levels:
- **PRESENT** — the capability is reachable at all (an endpoint/behavior exists for it).
- **FUNCTIONAL** — a realistic happy-path scenario succeeds end-to-end, proven by
  an executed request/response and, where relevant, a follow-up read confirming
  the effect persisted.
- **ROBUST** — bad input, missing resources, and edge cases are handled with a
  sane error (appropriate 4xx, clear message) and **without crashing** the service.

---

## C1. Create a bookmark
- **PRESENT:** There is a way to save a new bookmark with a link address (and
  optionally a title and description).
- **FUNCTIONAL:** Creating a bookmark returns the stored record (with some stable
  identifier); reading it back returns the same data. A creation timestamp is tracked.
- **ROBUST:**
  - Missing/empty link address is rejected with a client error (not a 500).
  - A non-web / malformed address (e.g. `ftp://x`, `not-a-url`, `javascript:...`)
    is rejected. Only `http`/`https`-style links are accepted.
  - Omitting the title still succeeds and yields a non-empty, sensible title
    derived from the link (e.g. its host), rather than a blank.

## C2. Read a single bookmark
- **PRESENT:** A saved bookmark can be fetched by its identifier.
- **FUNCTIONAL:** Fetching a known id returns that bookmark's full details.
- **ROBUST:** Fetching an unknown id returns a not-found error (404-style), not a
  crash or an empty 200.

## C3. List bookmarks
- **PRESENT:** All saved bookmarks can be listed.
- **FUNCTIONAL:** After creating several, the listing includes them. The response
  makes the total count / result set discoverable.
- **ROBUST:** Listing when there are zero bookmarks returns an empty result
  cleanly (not an error).

## C4. Update a bookmark
- **PRESENT:** A bookmark's editable fields (title, description, and/or link) can
  be changed.
- **FUNCTIONAL:** After an update, a fresh read reflects the new values; an
  "updated" timestamp advances / differs from creation.
- **ROBUST:** Updating an unknown id is a not-found error. An update that would
  set an invalid link is rejected; a partial update leaves unspecified fields intact.

## C5. Delete a bookmark
- **PRESENT:** A bookmark can be deleted.
- **FUNCTIONAL:** After deletion, fetching it returns not-found and it is gone
  from the listing.
- **ROBUST:** Deleting an unknown id returns a not-found error (or is otherwise
  handled cleanly), not a crash.

## C6. Duplicate prevention / data integrity
- **PRESENT:** The service has a notion of not storing the same link twice.
- **FUNCTIONAL:** Saving a bookmark whose link matches an existing one is rejected
  with a conflict-style error; the original is untouched and no second copy appears.
- **ROBUST:** The rejection is a clean client error (e.g. 409/400), not a 500 or a
  silent duplicate.

## C7. Keyword search
- **PRESENT:** Bookmarks can be searched by a keyword/query.
- **FUNCTIONAL:** A query returns bookmarks whose title, description, or link
  contains the term, and excludes non-matching ones. Matching is case-insensitive.
- **ROBUST:** A query that matches nothing returns an empty result, not an error.

## C8. Pagination
- **PRESENT:** Listing supports paging (page/limit or an equivalent).
- **FUNCTIONAL:** With more items than one page, requesting page 1 vs page 2 returns
  different, non-overlapping slices; a total/count is available so the client knows
  how many pages exist. A default page size applies when unspecified.
- **ROBUST:** Out-of-range pages (e.g. page far past the end) return an empty slice
  cleanly; an absurd page size is bounded/capped rather than dumping everything or
  crashing.

## C9. Sorting
- **PRESENT:** Listing results can be ordered by more than one criterion.
- **FUNCTIONAL:** At least newest/oldest (by creation) and an alphabetical
  (by title or link) ordering work, and ascending vs descending both produce the
  expected order. Sorting by popularity (visit count) is also supported.
- **ROBUST:** An unknown sort field / order falls back to a sane default instead
  of erroring or crashing.

## C10. Tagging
- **PRESENT:** Tags can be attached to a bookmark.
- **FUNCTIONAL:** After tagging, the bookmark's tags can be read back; a tag can be
  removed; adding the same tag twice does not create duplicates (idempotent).
- **ROBUST:** Tagging a non-existent bookmark is a not-found error; removing a tag
  that isn't present is handled cleanly (no crash).

## C11. Filter by tag
- **PRESENT:** The listing can be narrowed to a single tag.
- **FUNCTIONAL:** Filtering by a tag returns exactly the bookmarks carrying that
  tag and excludes others.
- **ROBUST:** Filtering by a tag that no bookmark has returns an empty result, not
  an error.

## C12. Tag overview
- **PRESENT:** The set of existing tags can be listed.
- **FUNCTIONAL:** The tag listing reflects tags currently in use, with a usage
  count (how many bookmarks carry each). Counts update as tags are added/removed.
- **ROBUST:** With no tags in the system, the overview is empty rather than broken.

## C13. Favorites
- **PRESENT:** A bookmark can be marked/flagged as a favorite.
- **FUNCTIONAL:** Marking a bookmark as favorite is reflected on the record; the
  listing can be filtered to just favorites and returns exactly those.
- **ROBUST:** Favoriting an unknown id is a not-found error, not a crash.

## C14. Archive / restore
- **PRESENT:** A bookmark can be archived and later restored.
- **FUNCTIONAL:** Archived bookmarks drop out of the default listing but still
  exist (retrievable directly or via an explicit "include archived" view);
  restoring brings a bookmark back into the normal listing.
- **ROBUST:** Archiving/restoring an unknown id is a not-found error; archiving is
  distinct from deletion (data is preserved).

## C15. Collections
- **PRESENT:** Named collections (folders/lists) can be created.
- **FUNCTIONAL:** A collection can be created, listed, and fetched; bookmarks can
  be added to and removed from it; the collection's bookmarks can be listed
  (ideally paged). Deleting a collection works.
- **ROBUST:** Adding a non-existent bookmark to a collection, or operating on a
  non-existent collection, yields a clean not-found/validation error. Duplicate
  collection names are handled consistently (rejected or deduped, not corrupt).
  Deleting a collection does not delete the bookmarks themselves.

## C16. Notes / annotations
- **PRESENT:** Free-text notes can be attached to a bookmark.
- **FUNCTIONAL:** A note added to a bookmark can be listed back; a note can be
  deleted.
- **ROBUST:** Adding a note to a non-existent bookmark, or deleting a non-existent
  note, is handled with a clean error (no crash).

## C17. Click / visit tracking
- **PRESENT:** Visiting/opening a bookmark can be recorded.
- **FUNCTIONAL:** Recording a visit increments that bookmark's visit count and
  updates a "last visited" timestamp; repeated visits accumulate. This count is
  usable as a sort criterion (see C9).
- **ROBUST:** Recording a visit on an unknown id is a not-found error, not a crash.

## C18. Bulk import
- **PRESENT:** Multiple bookmarks can be imported in one request.
- **FUNCTIONAL:** Importing a batch saves the valid entries (including any tags
  supplied with them) and reports a summary of how many succeeded and how many
  failed.
- **ROBUST:** A batch mixing valid and invalid/duplicate entries is a **partial
  success** — good ones persist, bad ones are reported with reasons, and the whole
  request does not fail or crash on the bad ones.

## C19. Export
- **PRESENT:** The whole collection can be exported.
- **FUNCTIONAL:** Export returns all bookmarks with their associated data (e.g.
  tags) in a self-contained structure that plausibly round-trips back through import.
- **ROBUST:** Exporting an empty system returns an empty-but-well-formed result,
  not an error.

## C20. Stats / overview
- **PRESENT:** A stats/summary view exists.
- **FUNCTIONAL:** The summary reports meaningful totals (bookmarks, favorites,
  archived, tags, collections, total visits) and highlights such as the
  most-visited bookmarks, most recently added, and most-used tags. Numbers are
  consistent with the data actually present.
- **ROBUST:** Stats on an empty system returns zeros/empty highlights cleanly, not
  a crash or NaN.

---

## Overall Quality & Usability
- **Coherence:** Resource naming and response shapes are consistent across the API;
  a developer could infer how to use one part from another. Related capabilities
  compose (e.g. tag then filter, favorite then filter-favorites, archive then
  default-list-excludes).
- **Status codes & errors:** Creates return a created-style success; reads of
  missing things return not-found; validation failures return client errors with a
  human-readable message. No capability returns a 500 for ordinary bad input.
- **Persistence & integrity:** Data survives a service restart (it is durably
  stored, not in-memory). Deleting a bookmark cleans up its dependent data (tags
  associations, notes, collection membership) rather than leaving orphans or
  crashing later reads. No duplicate links.
- **Health:** A basic health/liveness check responds.

## Bug-Hunt Focus (try to break it)
- Send malformed JSON, wrong types (number where string expected), and empty bodies
  to write endpoints — expect clean 4xx, never a 500 or hang.
- Non-numeric / negative / huge ids in the path — expect not-found or validation,
  no crash.
- Create a duplicate link, then confirm the listing/count did not gain a phantom entry.
- Tag the same bookmark with the same tag repeatedly; confirm no duplicate tags and
  that the tag usage count stays correct.
- Paginate past the end, request page size 0 or 100000, negative page — confirm
  bounded, sane behavior.
- Archive a bookmark and confirm it truly leaves the default list but is still
  retrievable and restorable; confirm archive ≠ delete.
- Delete a bookmark that is in a collection and has notes/tags; confirm dependent
  data is cleaned up and subsequent reads of the collection/stats don't break.
- Import a batch with some invalid/duplicate rows; confirm partial success and an
  accurate success/failure report rather than all-or-nothing failure.
- Cross-check `/stats` totals against the actual data after a sequence of
  create/favorite/archive/tag/visit operations — the numbers must stay consistent.
- Search/sort with unusual input (empty query, unknown sort key) — confirm graceful
  fallback rather than errors.
