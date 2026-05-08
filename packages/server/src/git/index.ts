/**
 * Git operations — snapshot, revert, commit, and remote operations.
 */

export class Git {
  static async clone(repo: string, branch: string, targetDir: string): Promise<Git> {
    const proc = Bun.spawn(["git", "clone", "--branch", branch, "--single-branch", repo, targetDir], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const timeout = setTimeout(() => proc.kill(), 300_000);
    const exitCode = await proc.exited;
    clearTimeout(timeout);

    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new GitError(`git clone failed: ${stderr.trim()}`);
    }
    return new Git(targetDir);
  }

  constructor(private projectDir: string) {
    const result = Bun.spawnSync(["git", "rev-parse", "--git-dir"], {
      cwd: projectDir,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode !== 0) {
      throw new GitError(`${projectDir} is not a git repository`);
    }
  }

  async currentHash(): Promise<string> {
    const result = this.run("rev-parse", "HEAD");
    return result.trim();
  }

  async createBranch(name: string): Promise<void> {
    this.runChecked("checkout", "-b", name);
  }

  async push(remote: string, branch: string): Promise<void> {
    this.runChecked("push", remote, branch);
  }

  async checkout(branch: string): Promise<void> {
    this.runChecked("checkout", branch);
  }

  async currentBranch(): Promise<string> {
    return this.runChecked("rev-parse", "--abbrev-ref", "HEAD").trim();
  }

  async hasChanges(): Promise<boolean> {
    const result = this.run("status", "--porcelain");
    return result.trim().length > 0;
  }

  async snapshot(message: string): Promise<string> {
    if (!(await this.hasChanges())) {
      return this.currentHash();
    }
    this.run("add", "-A");
    this.run("commit", "-m", message);
    return this.currentHash();
  }

  async revert(commitHash: string): Promise<void> {
    this.runChecked("reset", "--hard", commitHash);
  }

  async diffStat(fromHash: string, toHash = "HEAD"): Promise<string> {
    return this.run("diff", "--stat", fromHash, toHash).trim();
  }

  private run(...args: string[]): string {
    const result = Bun.spawnSync(["git", ...args], {
      cwd: this.projectDir,
      stdout: "pipe",
      stderr: "pipe",
    });
    return result.stdout.toString();
  }

  private runChecked(...args: string[]): string {
    const result = Bun.spawnSync(["git", ...args], {
      cwd: this.projectDir,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode !== 0) {
      throw new GitError(`git ${args[0]} failed: ${result.stderr.toString().trim()}`);
    }
    return result.stdout.toString();
  }
}

export class GitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitError";
  }
}
