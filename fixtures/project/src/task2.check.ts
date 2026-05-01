import { expect, test } from "bun:test";
import { multiply } from "./task2";

test("multiply returns product", () => {
  expect(multiply(3, 4)).toBe(12);
  expect(multiply(0, 5)).toBe(0);
  expect(multiply(-2, 3)).toBe(-6);
});
