/**
 * Nix environment integration — wraps orca run commands in the appropriate
 * nix shell/develop invocation based on config and auto-detection.
 */

import { existsSync, writeFileSync, unlinkSync } from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";
import type { NixConfig } from "./config/schema";

export interface NixFileChecker {
  exists(path: string): boolean;
}

const defaultChecker: NixFileChecker = { exists: existsSync };

/**
 * Build the full command array, wrapping innerCmd in a nix environment if applicable.
 *
 * Resolution order:
 * 1. nix.enable === false → no wrapping
 * 2. nix.flake defined → nix develop
 * 3. nix.packages defined → nix shell nixpkgs#pkg1 nixpkgs#pkg2 --command
 * 4. Auto-detect flake.nix in repoDir → nix develop
 * 5. Auto-detect shell.nix or default.nix → nix-shell --run
 * 6. No nix → bare command
 */
export function buildNixCommand(
  repoDir: string,
  nixConfig: NixConfig | undefined,
  innerCmd: string[],
  checker: NixFileChecker = defaultChecker,
): string[] {
  // Explicitly disabled
  if (nixConfig?.enable === false) {
    return innerCmd;
  }

  // 1. Explicit flake config
  if (nixConfig?.flake !== undefined) {
    const flakePath = nixConfig.flake === true
      ? repoDir
      : resolve(repoDir, nixConfig.flake as string);
    return ["nix", "develop", flakePath, "--command", ...innerCmd];
  }

  // 2. Explicit packages
  if (nixConfig?.packages && nixConfig.packages.length > 0) {
    const pkgArgs = nixConfig.packages.map((pkg) => `nixpkgs#${pkg}`);
    return ["nix", "shell", ...pkgArgs, "--command", ...innerCmd];
  }

  // 3. Auto-detect flake.nix
  if (checker.exists(join(repoDir, "flake.nix"))) {
    return ["nix", "develop", repoDir, "--command", ...innerCmd];
  }

  // 4. Auto-detect shell.nix
  const shellNix = join(repoDir, "shell.nix");
  if (checker.exists(shellNix)) {
    return ["nix-shell", shellNix, "--run", innerCmd.join(" ")];
  }

  // 5. Auto-detect default.nix
  const defaultNix = join(repoDir, "default.nix");
  if (checker.exists(defaultNix)) {
    return ["nix-shell", defaultNix, "--run", innerCmd.join(" ")];
  }

  // 6. No nix
  return innerCmd;
}

// ---------------------------------------------------------------------------
// Robust nix command execution via temp script files
// ---------------------------------------------------------------------------

let scriptCounter = 0;

/**
 * Build argv to run a shell command string inside a nix environment.
 *
 * Writes the command to a temp script file to avoid all shell quoting issues.
 * The script file must be cleaned up by the caller via the returned cleanup function.
 *
 * Returns { argv, cleanup } or null if no nix environment detected.
 */
export function buildNixScriptCommand(
  repoDir: string,
  command: string,
  nixConfig?: NixConfig,
  checker: NixFileChecker = defaultChecker,
): { argv: string[]; cleanup: () => void } | null {
  if (nixConfig?.enable === false) return null;

  const dir = resolve(repoDir);
  const scriptPath = join(tmpdir(), `orca-nix-${process.pid}-${++scriptCounter}.sh`);
  writeFileSync(scriptPath, command, { mode: 0o755 });
  const cleanup = () => { try { unlinkSync(scriptPath); } catch {} };

  // 1. Explicit flake
  if (nixConfig?.flake !== undefined) {
    const flakePath = nixConfig.flake === true ? dir : resolve(dir, nixConfig.flake as string);
    return { argv: ["nix", "develop", flakePath, "--command", "sh", scriptPath], cleanup };
  }

  // 2. Explicit packages
  if (nixConfig?.packages && nixConfig.packages.length > 0) {
    const pkgArgs = nixConfig.packages.map((pkg) => `nixpkgs#${pkg}`);
    return { argv: ["nix", "shell", ...pkgArgs, "--command", "sh", scriptPath], cleanup };
  }

  // 3. Auto-detect flake.nix
  if (checker.exists(join(dir, "flake.nix"))) {
    return { argv: ["nix", "develop", dir, "--command", "sh", scriptPath], cleanup };
  }

  // 4. Auto-detect shell.nix
  const shellNix = join(dir, "shell.nix");
  if (checker.exists(shellNix)) {
    return { argv: ["nix-shell", shellNix, "--run", scriptPath], cleanup };
  }

  // 5. Auto-detect default.nix
  const defaultNix = join(dir, "default.nix");
  if (checker.exists(defaultNix)) {
    return { argv: ["nix-shell", defaultNix, "--run", scriptPath], cleanup };
  }

  // No nix
  cleanup();
  return null;
}
