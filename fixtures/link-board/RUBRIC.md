# Link Board — Capability Rubric

Hidden from the builder. For the LLM judge only.

This is a **capability-level** acceptance checklist for a link-sharing community
platform (Hacker News style). Each capability is stated as a **behavioral
property** — an observable outcome, not a specific endpoint, field name, or wire
format. The builder was free to choose any reasonable API shape, naming, and
data model; grade the *behavior*, not the contract.

For each capability, grade three levels independently:

- **PRESENT** — the capability visibly exists (a route/operation for it responds
  at all, rather than 404 / "not found" / an unimplemented stub).
- **FUNCTIONAL** — a realistic end-to-end scenario actually succeeds. This MUST
  be proven by executing real requests against the running service and observing
  the responses. Do **not** grade FUNCTIONAL from reading source code alone.
- **ROBUST** — bad input, missing resources, and abuse are handled gracefully
  (sane error status, no crash, no data corruption) rather than 500s or silent
  wrong behavior.

Discover the actual API shape first (look for a route list, an `/llms.txt`, an
OpenAPI doc, a README, or probe common paths), then map these behaviors onto
whatever endpoints exist. If two capabilities are merged into one endpoint, or
split across several, that's fine — grade the behavior.

---

## Capability 1 — Members & Authentication

**Property:** A person can create an account, sign in, and thereafter act as an
authenticated identity. Actions are attributable to the actor, and only that
actor can act as themselves.

- **PRESENT:** There is a way to register a new account and a way to sign in
  that returns some proof of identity (a token, session, or equivalent).
- **FUNCTIONAL:** Register a fresh account → sign in with those credentials →
  use the returned credential to access an identity-scoped view ("who am I")
  and get back *that* account. Credentials from registration let you back in
  later.
- **ROBUST:**
  - Wrong password / unknown account is rejected (not accepted, not a 500).
  - Duplicate registration (same username or email) is refused, not silently
    duplicated.
  - Missing/garbage registration fields are rejected with a client error.
  - Protected operations reject requests that carry no credential, and reject a
    forged/garbage credential — both without leaking a stack trace or crashing.
  - Passwords are never stored or returned in plaintext (check any profile/user
    response for a leaked password or hash).

## Capability 2 — Submitting & Browsing Links

**Property:** An authenticated member can submit a link (a headline + a URL),
each submission is attributed to its author, and anyone can browse the shared
links.

- **PRESENT:** There is a way to submit a link and a way to list/browse links.
- **FUNCTIONAL:** Signed in, submit a link → it appears in the browse list,
  attributed to the submitter, with its headline and URL intact. Listing returns
  multiple submissions.
- **ROBUST:**
  - Submitting while unauthenticated is refused.
  - Submitting with a missing title/URL (or an obviously invalid URL) is
    rejected, not stored as garbage.
  - Browsing supports paging through many items without returning everything or
    breaking on out-of-range/negative page values.

## Capability 3 — Voting & Ranking

**Property:** Members express approval/disapproval on links, and that collective
signal drives ranking. Each member gets one standing vote per item, changeable
and removable.

- **PRESENT:** There is a way to vote on a link (at least approve; ideally
  approve/disapprove) and the listing reflects a score.
- **FUNCTIONAL:**
  - Cast a vote → the item's score changes accordingly.
  - The same member voting again does **not** stack (still counts once); changing
    approve→disapprove moves the score in the right direction; removing the vote
    returns the score toward neutral.
  - Browsing can be ordered so that popular/high-scoring items surface separately
    from merely newest items (i.e. there is more than one ordering, e.g. "new"
    vs "top"). A viewer can tell how they themselves voted on an item.
- **ROBUST:**
  - Voting while unauthenticated is refused.
  - Voting on a nonexistent item yields a clean not-found error, not a crash.
  - Rapid repeat votes cannot inflate a score beyond one-per-member.

## Capability 4 — Threaded Discussion

**Property:** Every link carries a discussion. Members comment on links and reply
to other comments, forming threads. Comments can be voted on, and removed
comments leave the thread intact.

- **PRESENT:** There is a way to comment on a link and a way to read a link's
  comments.
- **FUNCTIONAL:**
  - Post a comment on a link → it shows up under that link with its author and
    text.
  - Reply to an existing comment → the reply is associated with its parent so the
    nesting/thread structure is recoverable (a reader can reconstruct who replied
    to whom).
  - Comments carry author, a score, and a timestamp; comments can be voted on
    with the same one-per-member semantics as links.
  - Deleting a comment removes its content from view (e.g. shows as "[deleted]"
    or equivalent) **without** orphaning or destroying its replies.
- **ROBUST:**
  - Commenting/replying while unauthenticated is refused.
  - Commenting on a nonexistent link, or replying to a nonexistent parent, fails
    cleanly.
  - Empty/oversized comment bodies are handled sanely.

## Capability 5 — Profiles & Reputation

**Property:** Each member has a public profile showing who they are, when they
joined, what they've contributed, and a reputation score reflecting community
reception. Members can describe themselves.

- **PRESENT:** There is a way to look up a member's public profile.
- **FUNCTIONAL:**
  - Fetch a member's profile → get identity, a join date, and contribution
    counts (links and/or comments).
  - Reputation reflects votes the member's contributions received: when another
    member up-votes this member's link or comment, the author's reputation rises
    (and falls on down-votes). Verify by voting on a target's content and seeing
    their reputation move in the right direction.
  - A member's submitted links and their comments can be listed (their activity
    history), with paging.
  - A member can update their own self-description/bio, and the change is
    reflected on their profile.
- **ROBUST:**
  - Looking up an unknown member yields a clean not-found, not a crash.
  - A member cannot edit **another** member's profile/bio.
  - A brand-new member with no activity has a coherent profile (e.g. zero
    reputation, empty history) rather than an error.

## Capability 6 — Moderation & Search

**Property:** The community can police itself: members flag bad content, everyone
can search past content, and a privileged moderator can remove content and
discipline abusive members.

- **PRESENT:** There is a way to flag content, a way to search, and some notion
  of a privileged/moderator role.
- **FUNCTIONAL:**
  - **Flagging:** an authenticated member can flag a link or a comment; the flag
    is recorded.
  - **Search:** searching for a term finds matching links (by title/URL) and/or
    comments (by text), case-insensitively, with paging, and the results make
    clear what kind of thing each hit is.
  - **Moderator powers:** a privileged account can remove any link or comment,
    and can sanction (e.g. ban) a member. A sanctioned member is blocked from
    posting/voting while sanctioned, and can be reinstated. A moderator can view
    the queue of flagged content.
- **ROBUST:**
  - Ordinary members cannot use moderator powers (removing others' content,
    banning, viewing the flag queue) — such attempts are forbidden, not silently
    allowed.
  - Flagging/searching a nonexistent target or an empty query is handled without
    crashing.
  - A banned member's blocked actions fail cleanly with an authorization-style
    error, and reinstating restores their access.

---

## Overall Quality & Usability

Grade the platform holistically, independent of the per-capability checks:

- **Coherent API:** naming, structure, and behavior are consistent and
  predictable across resources (links, comments, votes, users). A newcomer could
  guess the shape of one operation from another.
- **Sane status & errors:** success vs. client-error vs. auth-error vs.
  not-found vs. conflict are distinguished with appropriate status codes;
  error responses are informative and machine-readable, not bare 500s or HTML
  stack traces.
- **Data integrity & persistence:** created content survives and reads back
  faithfully; scores, counts, reputation, and vote state stay internally
  consistent (e.g. a link's displayed score equals net votes; contribution
  counts match what was actually posted). Restarting the service should not lose
  committed data.
- **Authorization discipline:** identity is enforced everywhere it matters;
  members can only mutate their own things; privilege is required for privileged
  actions.
- **Overall usefulness:** taken together, could a real front end build a working
  Hacker-News-style experience on this API?

## Bug Hunt — things a skeptic should try to break

- Vote inflation: hammer the same vote repeatedly, or vote from many accounts,
  and confirm the score is exactly net one-per-member.
- Score/reputation drift: change and remove votes and confirm both the item
  score **and** the author's reputation return to correct values (no double
  counting, no negative-count nonsense).
- Identity spoofing: try to act as another member by tampering with the
  credential, or by passing another member's id in the body; confirm it's
  rejected.
- Privilege escalation: as an ordinary member, attempt every moderator action;
  confirm all are forbidden. Confirm a non-first / normal account is not
  accidentally privileged.
- Ban bypass: after being banned, try to post, vote, comment, and flag; confirm
  all are blocked until reinstated.
- Thread integrity: delete a parent comment that has replies; confirm replies
  survive and the tree is still reconstructable. Reply to a deleted comment.
- Injection & garbage: send SQL-ish strings, huge payloads, wrong types,
  missing fields, and malformed JSON to every write endpoint; confirm clean
  client errors, no 500s, no data corruption, no leaked internals.
- Pagination edges: negative/zero/huge page sizes and offsets past the end.
- Not-found consistency: operate on nonexistent links/comments/users everywhere;
  confirm consistent not-found handling rather than crashes.
- Cross-user mutation: vote-changing, editing, and deleting should never let one
  member affect another member's records except through legitimate voting.
