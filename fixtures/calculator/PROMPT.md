# Calculator Math Library

Build a small TypeScript math library that runs on Bun. It should expose four
basic arithmetic operations: **add**, **subtract**, **multiply**, and **divide**.

Each operation takes two numbers and returns the numeric result. The one wrinkle:
**dividing by zero must be treated as an error** — the library should signal a
clear failure rather than silently returning `Infinity` or `NaN`.

Ship the library with **unit tests** that exercise each operation, including the
divide-by-zero case, and make sure they pass.
