/**
 * Nix environment integration — wraps orca run commands in the appropriate
 * nix shell/develop invocation based on config and auto-detection.
 */

import { existsSync } from "fs";
import { join, resolve } from "path";
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
