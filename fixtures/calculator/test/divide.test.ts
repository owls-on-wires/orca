import { expect, test } from "bun:test";
import { divide } from "../src/divide";

test("divide(6, 2) returns 3", () => {
  expect(divide(6, 2)).toBe(3);
});

test("divide(7, 2) returns 3.5", () => {
  expect(divide(7, 2)).toBe(3.5);
});

test("divide(1, 0) throws an error", () => {
  expect(() => divide(1, 0)).toThrow();
});
