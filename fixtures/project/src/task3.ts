export function divide(a: number, b: number): number {
  // BUG: no zero-division check
  return a / b;
}
