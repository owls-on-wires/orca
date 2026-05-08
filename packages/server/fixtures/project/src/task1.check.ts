import { expect, test } from "bun:test";
import { add } from "./task1";

test("add returns sum", () => {
  expect(add(2, 3)).toBe(5);
  expect(add(-1, 1)).toBe(0);
  expect(add(0, 0)).toBe(0);
});
