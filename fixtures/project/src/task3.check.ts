import { expect, test } from "bun:test";
import { divide } from "./task3";

test("divide returns quotient", () => {
  expect(divide(10, 2)).toBe(5);
  expect(divide(7, 2)).toBe(3.5);
});

test("divide throws on zero", () => {
  expect(() => divide(1, 0)).toThrow("divide by zero");
});
