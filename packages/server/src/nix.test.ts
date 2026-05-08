import { describe, expect, test } from "bun:test";
import { buildNixCommand, type NixFileChecker } from "./nix";

// Mock file checker — returns true only for paths in the set
function mockChecker(existingFiles: string[]): NixFileChecker {
  const set = new Set(existingFiles);
  return { exists: (p: string) => set.has(p) };
}

const inner = ["orca", "run", "/repo/project.orca.yaml"];

describe("buildNixCommand", () => {
  test("nix.enable: false bypasses all nix wrapping", () => {
    const result = buildNixCommand("/repo", { enable: false, flake: true }, inner, mockChecker(["/repo/flake.nix"]));
    expect(result).toEqual(inner);
  });

  test("nix.flake: true uses nix develop with repo root", () => {
    const result = buildNixCommand("/repo", { flake: true }, inner, mockChecker([]));
    expect(result).toEqual(["nix", "develop", "/repo", "--command", ...inner]);
  });

  test("nix.flake: string path resolves relative to repoDir", () => {
    const result = buildNixCommand("/repo", { flake: "./subdir" }, inner, mockChecker([]));
    expect(result).toEqual(["nix", "develop", "/repo/subdir", "--command", ...inner]);
  });

  test("nix.packages uses nix shell with nixpkgs# prefix", () => {
    const result = buildNixCommand("/repo", { packages: ["nodejs", "bun", "git"] }, inner, mockChecker([]));
    expect(result).toEqual([
      "nix", "shell", "nixpkgs#nodejs", "nixpkgs#bun", "nixpkgs#git",
      "--command", ...inner,
    ]);
  });

  test("auto-detects flake.nix when no nix config", () => {
    const result = buildNixCommand("/repo", undefined, inner, mockChecker(["/repo/flake.nix"]));
    expect(result).toEqual(["nix", "develop", "/repo", "--command", ...inner]);
  });

  test("auto-detects shell.nix when no flake.nix", () => {
    const result = buildNixCommand("/repo", undefined, inner, mockChecker(["/repo/shell.nix"]));
    expect(result).toEqual(["nix-shell", "/repo/shell.nix", "--run", inner.join(" ")]);
  });

  test("auto-detects default.nix when no flake.nix or shell.nix", () => {
    const result = buildNixCommand("/repo", undefined, inner, mockChecker(["/repo/default.nix"]));
    expect(result).toEqual(["nix-shell", "/repo/default.nix", "--run", inner.join(" ")]);
  });

  test("shell.nix takes priority over default.nix", () => {
    const result = buildNixCommand("/repo", undefined, inner, mockChecker(["/repo/shell.nix", "/repo/default.nix"]));
    expect(result).toEqual(["nix-shell", "/repo/shell.nix", "--run", inner.join(" ")]);
  });

  test("flake.nix takes priority over shell.nix in auto-detect", () => {
    const result = buildNixCommand("/repo", undefined, inner, mockChecker(["/repo/flake.nix", "/repo/shell.nix"]));
    expect(result).toEqual(["nix", "develop", "/repo", "--command", ...inner]);
  });

  test("no nix files and no config returns bare command", () => {
    const result = buildNixCommand("/repo", undefined, inner, mockChecker([]));
    expect(result).toEqual(inner);
  });

  test("empty packages array returns bare command (no nix files)", () => {
    const result = buildNixCommand("/repo", { packages: [] }, inner, mockChecker([]));
    expect(result).toEqual(inner);
  });

  test("nix.flake takes priority over nix.packages", () => {
    const result = buildNixCommand("/repo", { flake: true, packages: ["nodejs"] }, inner, mockChecker([]));
    expect(result).toEqual(["nix", "develop", "/repo", "--command", ...inner]);
  });

  test("explicit nix config skips auto-detect even with nix files present", () => {
    const result = buildNixCommand("/repo", { packages: ["bun"] }, inner, mockChecker(["/repo/flake.nix"]));
    expect(result).toEqual(["nix", "shell", "nixpkgs#bun", "--command", ...inner]);
  });
});
