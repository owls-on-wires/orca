# Todo API — Capability Rubric

Hidden from the builder. For the LLM judge only.

This grades a **todo list REST API** built from `PROMPT.md`. The exact HTTP
contract is the builder's choice — do **not** assume specific paths, verbs,
field names, or response envelopes. Discover the real contract by exercising the
running service, then judge the **observable behavior** against the capabilities
below.

For each capability, grade three levels:

- **PRESENT** — the capability exists in some form (a route/operation for it
  responds rather than 404-ing the whole concept).
- **FUNCTIONAL** — a realistic scenario actually works, proven by an **executed
  request and its response**, not by reading source code.
- **ROBUST** — bad input and edge cases are handled without crashing or corrupting
  data; errors come back as sane client/server errors.

Notes for the judge:
- The service persists data (SQLite or equivalent) durably and **safely under
  concurrent access**. "Persistence" here means a created todo is visible to later
  requests against the same running service, and simultaneous writes do not lose or
  corrupt data.
- Field names will vary (`completed`/`done`/`is_done`, `id`, etc.). Match on
  meaning. Truthy/falsy representations of the done flag are acceptable as long
  as they round-trip consistently.
- Some listing features may be exposed as query parameters, request bodies, or
  separate routes — infer the mechanism from the API's own behavior.

---

## Capability 1 — Create a todo

Behavior: a client can create a new todo by supplying a title, and gets back the
stored todo including a server-assigned identifier and a done flag that starts
in the "not complete" state.

- **PRESENT**: a create operation exists and returns a representation of the new
  todo.
- **FUNCTIONAL**: creating a todo with a title returns that todo with a unique
  id and an initial done state of "not complete"; the success status indicates
  creation (e.g. a 2xx, ideally 201).
- **ROBUST**: creating two todos yields two distinct ids; created-at / ordering
  information is coherent.

## Capability 2 — List todos

Behavior: a client can retrieve the collection of todos.

- **PRESENT**: a list operation exists and returns a collection.
- **FUNCTIONAL**: after creating N todos, the list contains all N of them with
  their titles and done states; on an empty store it returns an empty collection
  (not an error).
- **ROBUST**: the shape of the list response is consistent whether the store is
  empty, small, or large.

## Capability 3 — Retrieve a single todo

Behavior: a client can fetch one todo by its identifier.

- **PRESENT**: a get-by-id operation exists.
- **FUNCTIONAL**: fetching a previously-created todo by its id returns that exact
  todo (matching title and done state).
- **ROBUST**: fetching an id that doesn't exist returns a not-found client error
  (e.g. 404), not a 500 and not a fabricated todo.

## Capability 4 — Update a todo

Behavior: a client can rename a todo and can mark it complete or incomplete.

- **PRESENT**: an update operation exists.
- **FUNCTIONAL**: renaming a todo persists the new title; marking a todo complete
  makes a subsequent retrieval report it as complete; marking it incomplete again
  reverts it. **The done flag must actually change and persist** (a common bug is
  the completion flag not being written correctly).
- **ROBUST**: updating a non-existent todo returns not-found; a partial update
  (changing only the title, or only the done flag) leaves the untouched field
  intact.

## Capability 5 — Delete a todo

Behavior: a client can remove a todo.

- **PRESENT**: a delete operation exists.
- **FUNCTIONAL**: deleting an existing todo succeeds, and a later retrieval or
  list no longer shows it.
- **ROBUST**: deleting a todo that doesn't exist (or deleting the same todo
  twice) returns a not-found client error rather than falsely reporting success
  or crashing.

## Capability 6 — Persistence across requests

Behavior: state created by one request is observable by independent later
requests to the same running service.

- **PRESENT**: data written by one request is retrievable by another.
- **FUNCTIONAL**: create a todo in one request, then in a separate request
  confirm it is listed/retrievable with the same data.
- **ROBUST**: a sequence of create/update/delete operations leaves the store in a
  consistent state (no duplicates, no ghosts, ids don't collide). **Concurrent
  writes are safe**: firing many simultaneous creates/updates loses no accepted
  write and corrupts nothing — no last-writer-wins clobbering of the store.

## Capability 7 — Filter by completion status

Behavior: the list can be narrowed to only the completed todos or only the
outstanding ones.

- **PRESENT**: some filtering mechanism for completion status exists.
- **FUNCTIONAL**: with a mix of complete and incomplete todos, asking for the
  completed subset returns only completed ones, and asking for the outstanding
  subset returns only incomplete ones.
- **ROBUST**: the filter combines sensibly with search/paging if those are
  present; an out-of-range or empty result set returns an empty collection, not
  an error.

## Capability 8 — Search by title

Behavior: the list can be narrowed to todos whose title contains a given word or
phrase, case-insensitively.

- **PRESENT**: some search-by-title mechanism exists.
- **FUNCTIONAL**: given several todos, searching for a substring returns exactly
  the todos whose titles contain it; the match ignores letter case.
- **ROBUST**: a search that matches nothing returns an empty collection (not an
  error); searching combines coherently with the completion filter if both are
  supported.

## Capability 9 — Pagination

Behavior: a long list can be retrieved in pages, and the client can learn the
total count.

- **PRESENT**: some paging mechanism exists (page/offset + size, or equivalent).
- **FUNCTIONAL**: with more todos than one page holds, requesting page 1 and
  page 2 returns different, non-overlapping todos; a total count reflecting the
  full result set is available.
- **ROBUST**: a page past the end returns an empty page with the correct total;
  a nonsensical page size (0, negative, or huge) is clamped or defaulted rather
  than crashing or returning the entire table.

## Capability 10 — Input validation & sane errors

Behavior: the API refuses invalid input clearly and never crashes on malformed
requests.

- **PRESENT**: at least basic validation exists on create/update.
- **FUNCTIONAL**: creating a todo with an empty or whitespace-only title is
  rejected with a client error (e.g. 400) and does **not** create a todo.
- **ROBUST**: malformed JSON, a missing body, wrong types (e.g. a numeric title
  or a non-boolean done flag), and unknown routes all produce sane client errors
  rather than 500s or process crashes.

---

## Overall Quality & Usability

- **Coherent contract**: routes/verbs/response shapes are consistent and
  predictable across the CRUD surface; the same resource looks the same
  everywhere.
- **Sane status codes**: creation returns a creation status; not-found returns
  404; bad input returns 4xx; successful reads return 200. Errors are not
  reported as 200.
- **Error messages**: failures come back as structured, human-readable messages,
  not raw stack traces.
- **Data integrity**: ids are stable and unique; the done flag round-trips as a
  proper boolean-ish value; timestamps/ordering are sensible; nothing silently
  loses or duplicates data.
- **Health**: the pre-existing health check still responds after the feature work.

## Bug-Hunt Focus (a skeptic should try to break these)

- **Completion flag write bug**: mark a todo complete, then re-fetch — does the
  done flag actually persist, or does it silently stay unchanged / revert?
- **Delete-of-missing**: deleting a non-existent or already-deleted id — does it
  falsely report success, or crash, instead of returning not-found?
- **Empty/whitespace title**: is `""` or `"   "` accepted as a valid todo? It
  should not be.
- **Malformed request bodies**: send invalid JSON, no body, or wrong-typed
  fields — does the server 500 / crash instead of returning a 4xx?
- **Filter/search correctness**: does `completed`-style filtering leak the wrong
  set? Is search accidentally case-sensitive or matching everything?
- **Pagination edges**: page beyond the end, size of 0 or negative, or an
  enormous size — is total still correct and is the whole table not dumped?
- **Persistence**: after a mix of creates/updates/deletes, re-list — are there
  ghosts, duplicates, or colliding ids?
