test("returns no additional roots outside Git", () => {
  const root = mkdtempSync(join(tmpdir(), "factorio-non-git-"));
  assert.deepEqual(resolveGitWritableDirectories(root), []);
});

test("rejects an assigned workspace below Git's reported work root", () => {
  const fixture = createLinkedWorktree();
  assert.throws(
    () => resolveGitWritableDirectories(join(fixture.worktree, "apps", "example")),
    /execution workspace to equal Git's reported work root/,
  );
});

test("returns only Git-reported stores outside the assigned workspace", () => {
  const fixture = createLinkedWorktree();
  const paths = resolveGitWritableDirectories(fixture.worktree);
  const common = git(fixture.worktree, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim();

  assert.equal(paths.length, 4);
  assert(paths.every((path) => containedBy(path, common)));
  assert(paths.some((path) => path.includes("/worktrees/")));
  assert(paths.some((path) => path.endsWith("/objects")));
  assert(paths.some((path) => path.endsWith("/refs")));
  assert(paths.some((path) => path.endsWith("/logs")));
});

function createLinkedWorktree(): LinkedFixture {
  const root = mkdtempSync(join(tmpdir(), "factorio-git-roots-"));
  const repository = join(root, "repository");
  const worktree = join(root, "worktree");
  mkdirSync(join(repository, "apps", "example"), { recursive: true });
  git(repository, ["init", "-b", "main"]);
  git(repository, ["config", "user.name", "Factorio Test"]);
  git(repository, ["config", "user.email", "test@axi-factorio.local"]);
  writeFileSync(join(repository, "README.md"), "fixture\n");
  git(repository, ["add", "."]);
  git(repository, ["commit", "-m", "fixture"]);
  git(repository, ["worktree", "add", "-b", "fixture-worktree", worktree]);
  mkdirSync(join(worktree, "apps", "example"), { recursive: true });
  return { root, repository, worktree };
}

function containedBy(path: string, parent: string): boolean {
  const relation = relative(parent, path);
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}

function git(root: string, args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
}

type LinkedFixture = { root: string; repository: string; worktree: string };

import { resolveGitWritableDirectories } from "../src/GitWritableDirectories.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import test from "node:test";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
