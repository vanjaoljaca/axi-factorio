export function createInstalledRuntimeProof(liveDatabasePath: string): InstalledRuntimeProof {
  const root = mkdtempSync(join(tmpdir(), "axi-factorio-installed-proof-"));
  const databasePath = join(root, "axi-factorio-proof.db");
  if (resolve(databasePath) === resolve(liveDatabasePath)) throw new Error(isolationError);
  return {
    root, databasePath,
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}

export function requireIsolatedProofDatabase(candidate: string, liveDatabasePath: string): string {
  const databasePath = resolve(candidate);
  if (databasePath === resolve(liveDatabasePath)) throw new Error(isolationError);
  return databasePath;
}

export type InstalledRuntimeProof = { root: string; databasePath: string; dispose: () => void };

const isolationError = "Installed runtime proof requires an isolated temporary database.";

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
