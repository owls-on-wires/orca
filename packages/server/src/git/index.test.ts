import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Git, GitError } from "./index";

function createTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "orca-git-test-"));
  Bun.spawnSync(["git", "init"], { cwd: dir, stdout: "ignore", stderr: "ignore" });
  Bun.spawnSync(["git", "config", "user.email", "test@test.com"], { cwd: dir });
  Bun.spawnSync(["git", "config", "user.name", "Test"], { cwd: dir });
  Bun.spawnSync(["git", "commit", "--allow-empty", "-m", "initial"], { cwd: dir, stdout: "ignore", stderr: "ignore" });
  return dir;
}

let repoDir: string;

beforeEach(() => {
  repoDir = createTempRepo();
});

afterEach(() => {
  rmSync(repoDir, { recursive: true, force: true });
});

describe("Git", () => {
  describe("constructor", () => {
    test("accepts a valid git repo", () => {
      expect(() => new Git(repoDir)).not.toThrow();
    });

    test("throws GitError for non-repo directory", () => {
      const notRepo = mkdtempSync(join(tmpdir(), "orca-git-notrepo-"));
      try {
        expect(() => new Git(notRepo)).toThrow(GitError);
      } finally {
        rmSync(notRepo, { recursive: true, force: true });
      }
    });
  });

  describe("currentHash", () => {
    test("returns a 40-char hex hash", async () => {
      const git = new Git(repoDir);
      const hash = await git.currentHash();
      expect(hash).toMatch(/^[0-9a-f]{40}$/);
    });
  });

  describe("hasChanges", () => {
    test("returns false for clean repo", async () => {
      const git = new Git(repoDir);
      expect(await git.hasChanges()).toBe(false);
    });

    test("returns true after creating a file", async () => {
      const git = new Git(repoDir);
      writeFileSync(join(repoDir, "test.txt"), "hello");
      expect(await git.hasChanges()).toBe(true);
    });

    test("returns true for staged changes", async () => {
      const git = new Git(repoDir);
      writeFileSync(join(repoDir, "test.txt"), "hello");
      Bun.spawnSync(["git", "add", "test.txt"], { cwd: repoDir });
      expect(await git.hasChanges()).toBe(true);
    });

    test("returns false after committing", async () => {
      const git = new Git(repoDir);
      writeFileSync(join(repoDir, "test.txt"), "hello");
      await git.snapshot("commit it");
      expect(await git.hasChanges()).toBe(false);
    });
  });

  describe("snapshot", () => {
    test("returns current hash when nothing to commit", async () => {
      const git = new Git(repoDir);
      const before = await git.currentHash();
      const hash = await git.snapshot("no changes");
      expect(hash).toBe(before);
    });

    test("creates a commit and returns new hash", async () => {
      const git = new Git(repoDir);
      const before = await git.currentHash();
      writeFileSync(join(repoDir, "file.txt"), "content");
      const hash = await git.snapshot("[orca snapshot] test");
      expect(hash).not.toBe(before);
      expect(hash).toMatch(/^[0-9a-f]{40}$/);
      expect(await git.hasChanges()).toBe(false);
    });

    test("includes untracked files", async () => {
      const git = new Git(repoDir);
      writeFileSync(join(repoDir, "new.txt"), "new file");
      const hash = await git.snapshot("include untracked");
      expect(await git.hasChanges()).toBe(false);
      // Verify the file is in the commit
      const result = Bun.spawnSync(["git", "show", "--name-only", hash], { cwd: repoDir });
      expect(result.stdout.toString()).toContain("new.txt");
    });
  });

  describe("revert", () => {
    test("restores file content to a previous commit", async () => {
      const git = new Git(repoDir);
      writeFileSync(join(repoDir, "file.txt"), "v1");
      const h1 = await git.snapshot("v1");

      writeFileSync(join(repoDir, "file.txt"), "v2");
      await git.snapshot("v2");
      expect(readFileSync(join(repoDir, "file.txt"), "utf8")).toBe("v2");

      await git.revert(h1);
      expect(readFileSync(join(repoDir, "file.txt"), "utf8")).toBe("v1");
    });

    test("removes files that didn't exist at target commit", async () => {
      const git = new Git(repoDir);
      const h0 = await git.currentHash();

      writeFileSync(join(repoDir, "file.txt"), "content");
      await git.snapshot("add file");
      expect(existsSync(join(repoDir, "file.txt"))).toBe(true);

      await git.revert(h0);
      expect(existsSync(join(repoDir, "file.txt"))).toBe(false);
    });

    test("throws GitError for invalid hash", async () => {
      const git = new Git(repoDir);
      await expect(git.revert("0000000000000000000000000000000000000000")).rejects.toThrow(GitError);
    });
  });

  describe("diffStat", () => {
    test("returns diff stat between commits", async () => {
      const git = new Git(repoDir);
      writeFileSync(join(repoDir, "file.txt"), "hello");
      const h1 = await git.snapshot("v1");

      writeFileSync(join(repoDir, "file.txt"), "world");
      await git.snapshot("v2");

      const stat = await git.diffStat(h1);
      expect(stat).toContain("file.txt");
      expect(stat).toContain("1 file changed");
    });

    test("returns empty string for identical commits", async () => {
      const git = new Git(repoDir);
      const hash = await git.currentHash();
      const stat = await git.diffStat(hash, hash);
      expect(stat).toBe("");
    });
  });

  describe("clone", () => {
    test("clones a bare repo and returns a Git instance", async () => {
      // Create a bare repo to clone from
      const bareDir = mkdtempSync(join(tmpdir(), "orca-git-bare-"));
      Bun.spawnSync(["git", "init", "--bare"], { cwd: bareDir, stdout: "ignore", stderr: "ignore" });

      // Push the test repo to the bare repo
      Bun.spawnSync(["git", "remote", "add", "origin", bareDir], { cwd: repoDir });
      Bun.spawnSync(["git", "push", "origin", "main"], { cwd: repoDir, stdout: "ignore", stderr: "ignore" });

      const cloneDir = mkdtempSync(join(tmpdir(), "orca-git-clone-"));
      rmSync(cloneDir, { recursive: true }); // clone needs a non-existent target

      try {
        const cloned = await Git.clone(bareDir, "main", cloneDir);
        expect(cloned).toBeInstanceOf(Git);
        const hash = await cloned.currentHash();
        expect(hash).toMatch(/^[0-9a-f]{40}$/);
      } finally {
        rmSync(bareDir, { recursive: true, force: true });
        rmSync(cloneDir, { recursive: true, force: true });
      }
    });

    test("throws GitError for invalid repo", async () => {
      const cloneDir = mkdtempSync(join(tmpdir(), "orca-git-clone-"));
      rmSync(cloneDir, { recursive: true });

      try {
        await expect(Git.clone("/nonexistent/repo", "main", cloneDir)).rejects.toThrow(GitError);
      } finally {
        rmSync(cloneDir, { recursive: true, force: true });
      }
    });
  });

  describe("createBranch", () => {
    test("creates and switches to a new branch", async () => {
      const git = new Git(repoDir);
      await git.createBranch("orca/test-build");
      const branch = await git.currentBranch();
      expect(branch).toBe("orca/test-build");
    });
  });

  describe("checkout", () => {
    test("switches to an existing branch", async () => {
      const git = new Git(repoDir);
      await git.createBranch("feature");
      await git.checkout("main");
      const branch = await git.currentBranch();
      expect(branch).toBe("main");
    });

    test("throws GitError for non-existent branch", async () => {
      const git = new Git(repoDir);
      await expect(git.checkout("nonexistent")).rejects.toThrow(GitError);
    });
  });

  describe("currentBranch", () => {
    test("returns the current branch name", async () => {
      const git = new Git(repoDir);
      const branch = await git.currentBranch();
      expect(branch).toBe("main");
    });
  });

  describe("push", () => {
    test("pushes to a remote bare repo", async () => {
      const bareDir = mkdtempSync(join(tmpdir(), "orca-git-bare-"));
      Bun.spawnSync(["git", "init", "--bare"], { cwd: bareDir, stdout: "ignore", stderr: "ignore" });
      Bun.spawnSync(["git", "remote", "add", "origin", bareDir], { cwd: repoDir });

      const git = new Git(repoDir);
      writeFileSync(join(repoDir, "push-test.txt"), "pushed");
      await git.snapshot("push commit");

      try {
        await git.push("origin", "main");

        // Verify by cloning the bare repo and checking the file exists
        const verifyDir = mkdtempSync(join(tmpdir(), "orca-git-verify-"));
        rmSync(verifyDir, { recursive: true });
        Bun.spawnSync(["git", "clone", bareDir, verifyDir], { stdout: "ignore", stderr: "ignore" });
        expect(existsSync(join(verifyDir, "push-test.txt"))).toBe(true);
        rmSync(verifyDir, { recursive: true, force: true });
      } finally {
        rmSync(bareDir, { recursive: true, force: true });
      }
    });

    test("throws GitError for invalid remote", async () => {
      const git = new Git(repoDir);
      await expect(git.push("nonexistent", "main")).rejects.toThrow(GitError);
    });
  });
});
