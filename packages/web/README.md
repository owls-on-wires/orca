The INTJ Stack

My goal is not to convince you that you should never use a framework again. My goal is to convince you that building apps this way is still a valid option in 2025. I would like this to be a tool that you can add to your toolbox, and use as you wish.

An architecture for building web applications without a framework.

The INTJ stack is an architecture… without a fully featured framework like Angular or React.

The components are:
Immer
Novel
Tailwind / Typescript
JQuery

Novel

Novel is a library for creating HTML elements using JavaScript functions.

Components that use Novel might look like this:
—-

Since everything here is pure JS, it complies with all of your linting and style rules and lives in a ts file. Novel natively supports Typescript, so all elements here are type-checked.

Novel objects are HTMLElements, so they work with native APIs:
—-

This pattern lends itself naturally to styling with libraries like Tailwind. You can add strings for classes, or abstract them.

—-

JQuery

As demonstrated in the component above, we are doing the rendering for this component manually using the browser DOM API. This may seem like a regression from the automatic rendering that libraries like React provide, but there are some advantages to this approach:

Explicit rendering: Since we write the code for all renders ourselves, it is easy to understand when and how a component is rendered into the DOM. This makes debugging rendering issues much more straightforward, as it doesn’t require internal knowledge of the framework.

It is difficult to understate the significance of this for larger applications.

The default linkage between state and render that frameworks provide, while convenient at smaller scales, can quickly become a burden as applications grow, since understanding when and how a component is being rendered involves an determining how the state is being updated, a non-trivial task for larger applications.

Performance by Default: no diff, no v DOM, entire stack is 100kb. Maximally efficient.

Easy to Optimize: simple at first, optimize later, no side effects

Scales Well:
At some point, you will be writing complex rendering code.

JQuery actually makes this process pretty easy, usually just a line of code to render.

You will have bugs in your application. The only difference is whether they are easy or hard to discover, diagnose, and fix.

On objection to this point from older crowds: we used to write all of our web applications this way, and they didn’t scale well at all! Mess of spaghetti code!

This is certainly a fair criticism. Under this model, however, I would like to make 2 points:

with Novel, we no longer write html strings in JS files, which eliminates the pasta problem;
Typescript. 

Oftentimes, the scaling issues with these applications were not an issue with rendering; in fact, many of these older applications are, in fact, extremely performant for this reason. The issue was management of state, which is difficult with JavaScript objects and no type safety. Proper use of Typescript alleviates this.

A complex table component with JQuery:

—-


Immer:

In previous examples, we have used a simple JavaScript object for storing state. However, as state objects get more complex, we quickly encounter some inconveniences:

—- deep cloning

Since Typescript does not include features for pointer type safety, we can still leave ourselves vulnerable to accidental reference bugs:

—- react deep object example

Using Immer, we can instead:
Have immutable state (no tricky reference bugs)
Write code in a mutating style

—-

Putting it Together

All together, we have this:

—-

html is dynamic, but pure JS
rendering is explicit
tailwind lets us style quickly
state updates with Immer
TS gives us full type-checking

Tiny bundles, excellent performance, excellent workability, scales easily

Include other libraries as needed.

Concurrency

Show a web socket / mutator example from Serenity:

—-

Disadvantages:
Writing complex rendering code for things that are trivially solved by diffing
This results in more app code, but NOT tech debt:
Is already optimized for efficiency
Is also easy to read, understand, and change
Does require changes to rendering methods when the component structure is updated
This applies to React and other frameworks also, but probably to a lesser extent