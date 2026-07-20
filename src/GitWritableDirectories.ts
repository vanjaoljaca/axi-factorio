export function resolveGitWritableDirectories(executionRoot: string): string[] {
  const root = realpathSync(executionRoot);
  const repository = readRepository(root);
  if (!repository || repository.gitDir === repository.commonDir) return [];
  requireExactWorktree(root, repository);
  return writableGitPaths(root, repository);
}

function readRepository(root: string): RepositoryPaths | null {
  const result = spawnSync("git", [
    "-C", root, "rev-parse", "--path-format=absolute",
    "--show-toplevel", "--git-dir", "--git-common-dir",
  ], textResult);
  if (result.status !== 0 && notRepository(result.stderr)) return null;
  if (result.status !== 0) throw new Error(`Unable to resolve Git repository: ${result.stderr.trim()}`);
  const [topLevel, gitDir, commonDir] = result.stdout.trim().split("\n").map(canonical);
  if (!topLevel || !gitDir || !commonDir) throw new Error("Git returned incomplete repository paths.");
  return { topLevel, gitDir, commonDir };
}

function requireExactWorktree(root: string, repository: RepositoryPaths): void {
  if (repository.topLevel !== root) {
    throw new Error("Linked-worktree Git metadata requires the execution workspace to equal the worktree root.");
  }
  const registered = gitOutput(root, ["worktree", "list", "--porcelain", "-z"])
    .split("\0").filter((field) => field.startsWith("worktree "))
    .map((field) => canonical(field.slice("worktree ".length)));
  if (!registered.includes(root)) throw new Error("Execution workspace is not a registered Git worktree.");
  if (!containedBy(repository.gitDir, repository.commonDir)) {
    throw new Error("Git worktree metadata is outside its reported common directory.");
  }
}

function writableGitPaths(root: string, repository: RepositoryPaths): string[] {
  const output = gitOutput(root, [
    "rev-parse", "--path-format=absolute",
    "--git-path", "objects", "--git-path", "refs", "--git-path", "logs",
  ]);
  const paths = [repository.gitDir, ...output.trim().split("\n").map(canonical)]
    .filter((path) => existsSync(path));
  for (const path of paths) requireGitOwned(path, repository.commonDir);
  return [...new Set(paths)];
}

function requireGitOwned(path: string, commonDir: string): void {
  if (!containedBy(path, commonDir)) {
    throw new Error(`Refusing unrelated additional writable directory: ${path}`);
  }
}

function containedBy(path: string, parent: string): boolean {
  const relation = relative(parent, path);
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}

function gitOutput(root: string, args: string[]): string {
  const result = spawnSync("git", ["-C", root, ...args], textResult);
  if (result.status !== 0) throw new Error(`Git metadata query failed: ${result.stderr.trim()}`);
  return result.stdout;
}

function canonical(path: string): string {
  return realpathSync(path);
}

function notRepository(stderr: string): boolean {
  return /not a git repository/iu.test(stderr);
}

type RepositoryPaths = { topLevel: string; gitDir: string; commonDir: string };

const textResult = { encoding: "utf8" as const };

import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
