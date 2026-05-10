import { expect, test } from "bun:test";
import { subtract } from "../src/subtract";

test("subtract(5, 3) returns 2", () => {
  expect(subtract(5, 3)).toBe(2);
});

test("subtract(0, 0) returns 0", () => {
  expect(subtract(0, 0)).toBe(0);
});

test("subtract(1, 5) returns -4", () => {
  expect(subtract(1, 5)).toBe(-4);
});
