# Todo List API

Build a small web service (a REST API) that lets a client keep track of a todo
list. It runs on Bun and stores its data so that todos survive between requests —
if a todo is created, a later request should still see it.

A todo is a simple thing: at minimum it has a **title** (the text of what needs
doing) and a **done/complete flag** that tracks whether it's finished. It's also
handy to know when each todo was created.

The service should let a client do the full lifecycle of managing todos:

- **Create** a new todo from a title. A todo starts out not-yet-complete.
- **List** all the todos.
- **Retrieve** a single todo by its identifier.
- **Update** an existing todo — rename it, and mark it complete or incomplete.
- **Delete** a todo.

Beyond the basics, make the list genuinely useful when it gets long:

- Let the client **filter** the list to just the completed or just the
  outstanding todos.
- Let the client **search** todos by a word or phrase in the title
  (case shouldn't matter).
- Let the client **page through** a long list rather than getting everything at
  once, and let them see how many todos there are in total.

Be a good API citizen: reject nonsense input (an empty or whitespace-only title
isn't a real todo) with a clear client error, respond sensibly when someone asks
for or changes a todo that doesn't exist, and use status codes that match what
happened. Don't crash on malformed requests.

The service already boots and answers a basic health check; build the todo
functionality on top of that.
