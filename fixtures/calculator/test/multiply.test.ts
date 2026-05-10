import { expect, test } from "bun:test";
import { multiply } from "../src/multiply";

test("multiply(2, 3) returns 6", () => {
  expect(multiply(2, 3)).toBe(6);
});

test("multiply(0, 5) returns 0", () => {
  expect(multiply(0, 5)).toBe(0);
});

test("multiply(-2, 4) returns -8", () => {
  expect(multiply(-2, 4)).toBe(-8);
});
