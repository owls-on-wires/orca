# Bookmark Manager API

Build a backend service for a personal **bookmark manager** — the kind of tool
someone uses to save links they want to keep, come back to, and stay organized
around. It should be a real HTTP API that a web or mobile client could talk to,
with the data persisted so nothing is lost when the service restarts.

## What people should be able to do with it

- **Save bookmarks.** Store a link with, at minimum, its address, plus an
  optional title and a short description. If the title is left blank, fill in
  something reasonable derived from the link itself. Only sensible web links
  should be accepted.
- **Browse and find them.** List saved bookmarks, and search across them by
  keyword so it's easy to rediscover something saved a while ago.
- **Keep the list manageable.** When there are lots of bookmarks, the listing
  should come back in pages rather than all at once, and it should be possible
  to sort the results in the ways that matter (newest first, alphabetical, most
  visited, and so on).
- **Organize with tags.** Attach one or more free-form tags to a bookmark,
  remove them, and filter the collection down to a single tag. It should be easy
  to see which tags exist and roughly how much each one is used.
- **Organize into collections.** Group related bookmarks into named collections
  (think folders or reading lists), add and remove bookmarks from a collection,
  and view everything in a given collection.
- **Mark the ones that matter.** Flag bookmarks as favorites and be able to see
  just the favorites.
- **Get things out of the way.** Archive bookmarks that are no longer active so
  they drop out of the normal listing without being deleted, and restore them
  later if needed.
- **Edit and delete.** Update a saved bookmark's details, and delete ones that
  are no longer wanted.
- **Annotate.** Attach short notes or comments to a bookmark for extra context,
  and remove them.
- **Track usage.** Record when a bookmark is visited/opened so the service knows
  how popular each one is and when it was last used.
- **Move data in and out.** Support importing a batch of bookmarks in one go
  (partial success is fine — good ones save, bad ones are reported), and
  exporting the whole collection in a form that could be re-imported or backed up.
- **See the big picture.** Offer a simple stats/overview: how many bookmarks,
  favorites, archived, tags, collections, total visits, plus highlights like the
  most-visited and most recently added bookmarks and the most-used tags.

## Qualities that matter

- Sensible, predictable HTTP behavior: success and error responses should use
  appropriate status codes, and bad or malformed input should produce a clear
  error rather than a crash or a corrupt record.
- Data integrity: no duplicate saved links, related data (tags, notes,
  collection membership) cleaned up when a bookmark goes away, and everything
  durably persisted.
- The API should be coherent and self-consistent enough that a developer could
  figure out how to use it without hand-holding.

You own all technical decisions — the resource layout, request/response shapes,
storage design, and how the pieces fit together. A minimal server that already
answers a health check is provided as a starting point; build the product on top
of it.
