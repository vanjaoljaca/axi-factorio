export class LocalEndpointSupervisor {
  private readonly sessions = new Map<string, ActiveLocalEndpoint>();
  private readonly healthTimeoutMs: number;

  constructor(options: LocalEndpointSupervisorOptions = {}) {
    this.healthTimeoutMs = options.healthTimeoutMs ?? defaultHealthTimeoutMs;
  }

  async inspectWorkspace(
    workspaceRoot: string,
    expectedHead: string,
    declaration: LocalEndpointDeclarationValue,
  ): Promise<LocalEndpointWorkspace> {
    const root = realpathSync(workspaceRoot);
    await requireExactIdentity(root, expectedHead);
    return { root, ...validateDeclaration(declaration) };
  }

  async start(
    runId: string,
    workspaceRoot: string,
    declaration?: LocalEndpointDeclarationValue | null,
    port?: number,
  ): Promise<LocalEndpointSession | null> {
    const root = realpathSync(workspaceRoot);
    if (!declaration) return null;
    if (this.sessions.has(runId)) return this.sessions.get(runId)!.session;
    const identity = await requireCleanGitIdentity(root);
    const assignedPort = port ?? await availablePort();
    return this.launchAndVerify(runId, root, identity.head, assignedPort, validateDeclaration(declaration));
  }

  async recover(lease: LocalEndpointLease): Promise<LocalEndpointSession> {
    const root = realpathSync(lease.workspaceRoot);
    await requireExactIdentity(root, lease.gitHead);
    const active = this.sessions.get(lease.id);
    if (samePersistedSession(active, lease) && processAlive(lease.pid) && await isHealthy(lease.url)) {
      return active.session;
    }
    if (processAlive(lease.pid) && await isHealthy(lease.url)) return this.adopt(lease, root);
    if (processAlive(lease.pid)) await terminatePid(lease.pid);
    this.sessions.delete(lease.id);
    const declaration = {
      command: lease.command,
      args: lease.args,
      healthPath: new URL(lease.url).pathname,
    };
    const session = await this.start(lease.id, root, declaration, lease.port);
    if (!session) throw new Error("Local endpoint declaration is no longer available.");
    return session;
  }

  async stop(runId: string, persistedPid?: number): Promise<void> {
    const active = this.sessions.get(runId);
    this.sessions.delete(runId);
    const pid = active?.session.pid ?? persistedPid;
    if (active?.child) await terminate(active.child);
    else if (pid) await terminatePid(pid);
    log("local_endpoint_stopped", { runId, pid: pid ?? -1, url: active?.session.url ?? "persisted" });
  }

  private async launchAndVerify(
    runId: string, cwd: string, gitHead: string, port: number, declaration: LocalEndpointDeclaration,
  ): Promise<LocalEndpointSession> {
    const active = launchLocalEndpoint(runId, cwd, gitHead, port, declaration);
    this.sessions.set(runId, active);
    try {
      await requireHealthy(active, this.healthTimeoutMs);
      log("local_endpoint_healthy", active.session);
      return active.session;
    } catch (error) {
      await this.stop(runId);
      throw error;
    }
  }

  private adopt(lease: LocalEndpointLease, cwd: string): LocalEndpointSession {
    const session = {
      runId: lease.id, url: lease.url, cwd, gitHead: lease.gitHead,
      pid: lease.pid, port: lease.port, command: lease.command, args: lease.args,
    };
    this.sessions.set(lease.id, { child: null, session, output: "" });
    log("local_endpoint_recovered", session);
    return session;
  }
}

function samePersistedSession(
  active: ActiveLocalEndpoint | undefined,
  lease: LocalEndpointLease,
): active is ActiveLocalEndpoint {
  return active?.session.pid === lease.pid
    && active.session.url === lease.url
    && active.session.gitHead === lease.gitHead;
}

export function validateLocalEndpointDeclaration(value: unknown): LocalEndpointDeclarationValue {
  return validateDeclaration(value as Partial<LocalEndpointDeclarationValue>);
}

function validateDeclaration(value: Partial<LocalEndpointDeclarationValue>): LocalEndpointDeclarationValue {
  if (typeof value.command !== "string" || !value.command.trim()) throw invalidDeclaration("command");
  if (!Array.isArray(value.args) || !value.args.every((item) => typeof item === "string")) {
    throw invalidDeclaration("args");
  }
  requireSafeArgv(value.command, value.args);
  return { command: value.command, args: value.args, healthPath: requireHealthPath(value.healthPath) };
}

export function migrateLegacyLocalEndpointDeclarations(
  store: ConveyorStore,
): LegacyLocalEndpointMigration[] {
  const workspaces = groupBlobsByWorkspace(store.listBlobs());
  return [...workspaces.values()].flatMap((blobs) => {
    try {
      return migrateLegacyWorkspace(store, blobs);
    } catch (error) {
      const [blob] = blobs;
      log("local_endpoint_declaration_migration_failed", {
        blobIds: blobs.map((item) => item.id),
        path: join(blob.executionWorkspaceRoot, legacyDirectory, legacyFile),
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  });
}

function migrateLegacyWorkspace(store: ConveyorStore, blobs: Blob[]): LegacyLocalEndpointMigration[] {
  const root = blobs[0].executionWorkspaceRoot;
  const path = join(root, legacyDirectory, legacyFile);
  if (!existsSync(path)) return [];
  const declaration = validateLocalEndpointDeclaration(JSON.parse(readFileSync(path, "utf8")));
  const results = blobs.map((blob) => {
    const existing = store.getLocalEndpointDeclaration(blob.id);
    if (!existing) store.declareLocalEndpoint(blob.id, { workspaceRoot: root, ...declaration });
    return { blobId: blob.id, path, imported: !existing, removed: false };
  });
  const removed = removeLegacyDeclaration(root, path);
  const migrations = results.map((result) => ({ ...result, removed }));
  log("local_endpoint_declaration_migrated", {
    blobIds: migrations.map((item) => item.blobId),
    path,
    importedCount: migrations.filter((item) => item.imported).length,
    removed,
  });
  return migrations;
}

function groupBlobsByWorkspace(blobs: Blob[]): Map<string, Blob[]> {
  const result = new Map<string, Blob[]>();
  for (const blob of blobs) {
    const group = result.get(blob.executionWorkspaceRoot) ?? [];
    group.push(blob);
    result.set(blob.executionWorkspaceRoot, group);
  }
  return result;
}

function removeLegacyDeclaration(root: string, path: string): boolean {
  if (gitTracksLegacyDeclaration(root)) {
    log("local_endpoint_legacy_declaration_retained", { path, reason: "tracked-source-file" });
    return false;
  }
  unlinkSync(path);
  const directory = join(root, legacyDirectory);
  if (readdirSync(directory).length === 0) rmdirSync(directory);
  return true;
}

function gitTracksLegacyDeclaration(root: string): boolean {
  try {
    execFileSync(
      "git",
      ["-C", root, "ls-files", "--error-unmatch", "--", `${legacyDirectory}/${legacyFile}`],
      { stdio: "ignore" },
    );
    return true;
  } catch {
    return false;
  }
}

function requireSafeArgv(command: string, args: string[]): void {
  if (command.includes("\0") || args.some((item) => item.includes("\0"))) throw invalidDeclaration("NUL byte");
  const executable = command.split(/[\\/]/).at(-1)?.toLowerCase();
  if (forbiddenShells.has(executable ?? "")) throw invalidDeclaration("shell executable");
}

function requireHealthPath(value: unknown): string {
  if (value === undefined) return "/";
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) {
    throw invalidDeclaration("healthPath");
  }
  return value;
}

async function requireExactIdentity(root: string, expected: string): Promise<void> {
  const identity = await requireCleanGitIdentity(root);
  if (identity.head !== expected) throw new Error("Local endpoint workspace head changed while its lease was active.");
}

async function requireCleanGitIdentity(root: string): Promise<{ head: string }> {
  const head = (await execGit(root, ["rev-parse", "HEAD"])).trim();
  const status = (await execGit(root, ["status", "--porcelain"])).trim();
  if (status) throw new Error("Local endpoint requires a clean committed workspace head.");
  return { head };
}

function launchLocalEndpoint(
  runId: string, cwd: string, gitHead: string, port: number, declaration: LocalEndpointDeclaration,
): ActiveLocalEndpoint {
  const child = spawn(declaration.command, declaration.args, {
    cwd, detached: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), AXI_FACTORIO_ENDPOINT_PORT: String(port) },
  });
  const url = `http://127.0.0.1:${port}${declaration.healthPath}`;
  const session = { runId, url, cwd, gitHead, port, pid: child.pid ?? -1, command: declaration.command, args: declaration.args };
  const active = { child, session, output: "" };
  child.stdout?.on("data", (chunk) => active.output = tail(active.output, chunk));
  child.stderr?.on("data", (chunk) => active.output = tail(active.output, chunk));
  log("local_endpoint_started", session);
  return active;
}

async function requireHealthy(active: ActiveLocalEndpoint, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (active.child?.exitCode !== null) throw launchFailure(active);
    if (await isHealthy(active.session.url)) return;
    await pause(healthPollMs);
  }
  throw new Error(`Local endpoint health timed out at ${active.session.url}: ${active.output.trim()}`);
}

async function isHealthy(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(healthRequestMs) });
    return response.ok;
  } catch {
    return false;
  }
}

function launchFailure(active: ActiveLocalEndpoint): Error {
  return new Error(`Local endpoint exited before health at ${active.session.url}: ${active.output.trim()}`);
}

function execGit(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolveGit, rejectGit) => execFile("git", ["-C", cwd, ...args], (error, stdout, stderr) => {
    if (error) rejectGit(new Error(`Git identity check failed: ${String(stderr).trim() || error.message}`));
    else resolveGit(stdout);
  }));
}

function availablePort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.once("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return server.close(() => rejectPort(new Error("Could not allocate a local endpoint port.")));
      server.close((error) => error ? rejectPort(error) : resolvePort(address.port));
    });
  });
}

function terminate(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || !child.pid) return Promise.resolve();
  try { process.kill(-child.pid, "SIGTERM"); } catch (error) { if (!isGone(error)) throw error; }
  return Promise.race([once(child, "close").then(() => undefined), pause(terminationMs)]).then(() => {
    if (child.exitCode === null) try { process.kill(-child.pid!, "SIGKILL"); } catch (error) { if (!isGone(error)) throw error; }
  });
}

async function terminatePid(pid: number): Promise<void> {
  try { process.kill(-pid, "SIGTERM"); } catch (error) { if (!isGone(error)) throw error; }
  await pause(terminationMs);
  if (!processAlive(pid)) return;
  try { process.kill(-pid, "SIGKILL"); } catch (error) { if (!isGone(error)) throw error; }
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return !isGone(error); }
}

function invalidDeclaration(field: string): Error {
  return new Error(`Invalid local endpoint declaration ${field}.`);
}

function isGone(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ESRCH";
}

function tail(current: string, chunk: unknown): string {
  return `${current}${String(chunk)}`.slice(-8_000);
}

function pause(milliseconds: number): Promise<void> {
  return new Promise((resolvePause) => setTimeout(resolvePause, milliseconds));
}

export type LocalEndpointSession = {
  runId: string; url: string; cwd: string; gitHead: string; port: number; pid: number;
  command: string; args: string[];
};
export type LocalEndpointSupervisorOptions = { healthTimeoutMs?: number };
export type LocalEndpointWorkspace = LocalEndpointDeclaration & { root: string };
export type LocalEndpointDeclarationValue = { command: string; args: string[]; healthPath: string };
export type LegacyLocalEndpointMigration = {
  blobId: string; path: string; imported: boolean; removed: boolean;
};
type LocalEndpointDeclaration = LocalEndpointDeclarationValue;
type ActiveLocalEndpoint = { child: ChildProcess | null; session: LocalEndpointSession; output: string };

const defaultHealthTimeoutMs = 60_000;
const healthPollMs = 100;
const healthRequestMs = 500;
const terminationMs = 1_000;
const forbiddenShells = new Set(["sh", "bash", "zsh", "fish", "cmd", "cmd.exe", "powershell", "pwsh"]);
const legacyDirectory = ".axi-factorio";
const legacyFile = "local-endpoint.json";

import type { ChildProcess } from "node:child_process";
import type { Blob, LocalEndpointLease } from "./Types.ts";
import type { ConveyorStore } from "./Store.ts";
import { execFile, execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync, rmdirSync, unlinkSync } from "node:fs";
import { createServer } from "node:net";
import { once } from "node:events";
import { join } from "node:path";
import { log } from "./Logger.ts";
