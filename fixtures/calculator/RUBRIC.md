# Calculator Math Library — Capability Rubric

Hidden from the builder. For the LLM judge only.

Grade the delivered library against the capabilities below. Prefer proving
behavior by actually calling the code (import it, or run its tests) over reading
the source. Capabilities are described by observable behavior, not by any
specific function signature, module layout, or file name — as long as the four
operations are callable in some reasonable way and behave correctly, the exact
API shape does not matter.

## Capabilities

### C1. Addition
- **PRESENT:** An addition operation is exposed and callable.
- **FUNCTIONAL:** Adding two numbers returns their sum (e.g. `2 + 3 → 5`,
  `-1 + 1 → 0`).
- **ROBUST:** Works across signs and zero (negatives, `0 + 0 → 0`); does not
  crash on decimals or large magnitudes.

### C2. Subtraction
- **PRESENT:** A subtraction operation is exposed and callable.
- **FUNCTIONAL:** Subtracting returns the difference (e.g. `5 - 3 → 2`,
  `1 - 5 → -4`).
- **ROBUST:** Correct for results that go negative and for zero operands.

### C3. Multiplication
- **PRESENT:** A multiplication operation is exposed and callable.
- **FUNCTIONAL:** Multiplying returns the product (e.g. `2 * 3 → 6`,
  `-2 * 4 → -8`). Note: it must genuinely multiply, not add.
- **ROBUST:** `0 * anything → 0`; signs handled correctly.

### C4. Division
- **PRESENT:** A division operation is exposed and callable.
- **FUNCTIONAL:** Dividing returns the quotient, including non-integer results
  (e.g. `6 / 2 → 3`, `7 / 2 → 3.5`).
- **ROBUST:** Correct with negative operands and fractional results.

### C5. Divide-by-zero is an error
- **PRESENT:** Division has explicit handling for a zero divisor.
- **FUNCTIONAL:** Dividing any number by zero signals a failure (throws / returns
  an error result) rather than returning `Infinity`, `-Infinity`, or `NaN`. The
  failure is unambiguous to a caller.
- **ROBUST:** Holds for positive, negative, and zero numerators (`5/0`, `-5/0`,
  `0/0` all fail cleanly); the error is descriptive enough to explain the cause.

### C6. Unit tests exist and pass
- **PRESENT:** The project has an automated test suite wired to a test runner
  (runnable, e.g. via `bun test`).
- **FUNCTIONAL:** Running the suite passes, and it covers all four operations
  plus the divide-by-zero behavior.
- **ROBUST:** Tests assert real expected values (not trivially-true assertions)
  and include at least one negative/edge case per operation area.

## Overall Quality & Usability
- The four operations are discoverable and callable in a coherent, consistent way
  (uniform argument order and return convention across operations).
- Correct numeric results — no off-by-operation bugs (e.g. multiply that actually
  adds).
- The divide-by-zero failure is a first-class, intentional behavior, not an
  accidental `Infinity`/`NaN` leaking out.
- No build/type errors; the library imports cleanly under Bun/TypeScript.

## Bug-Hunt Focus (try to break it)
- Does `multiply` really multiply, or does it secretly add? Check `2 * 3` vs a
  case where sum ≠ product.
- Does `divide` leak `Infinity`/`NaN` for `x / 0`, `0 / 0`, or `-x / 0`?
- Are negative and fractional results handled (`1 - 5`, `7 / 2`), or is there
  rounding/truncation?
- Are the tests meaningful, or do they assert nothing (empty tests, `toBe(true)`,
  no divide-by-zero coverage)?
- Floating-point surprises (e.g. `0.1 + 0.2`) — acceptable if standard IEEE
  behavior, but the suite shouldn't crash on decimals.
