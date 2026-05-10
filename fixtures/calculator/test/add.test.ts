import { expect, test } from "bun:test";
import { add } from "../src/add";

test("add(2, 3) returns 5", () => {
  expect(add(2, 3)).toBe(5);
});

test("add(-1, 1) returns 0", () => {
  expect(add(-1, 1)).toBe(0);
});

test("add(0, 0) returns 0", () => {
  expect(add(0, 0)).toBe(0);
});
