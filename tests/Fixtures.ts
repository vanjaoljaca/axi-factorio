export function createPipeline(stepIds = ["plan.define"]): PipelineFixture {
  const root = mkdtempSync(join(tmpdir(), "axi-factorio-"));
  const pipelinePath = join(root, "pipeline");
  mkdirSync(pipelinePath);
  for (const [order, id] of stepIds.entries()) writeStep(pipelinePath, order, id);
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "factorio@test.invalid"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Factorio Test"], { cwd: root });
  commitAll(root, "pipeline");
  return { root, pipelinePath };
}

export function writeStep(
  pipelinePath: string,
  order: number,
  id: string,
  entry = `entry:${id}`,
  exit = `exit:${id}`,
): void {
  const [group, name] = id.split(".");
  writeFileSync(join(pipelinePath, `${order}.${group}.${name}.entry.md`), entry);
  writeFileSync(join(pipelinePath, `${order}.${group}.${name}.exit.md`), exit);
}

export function commitAll(root: string, message: string): void {
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-q", "-m", message], { cwd: root });
}

export type PipelineFixture = { root: string; pipelinePath: string };

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
