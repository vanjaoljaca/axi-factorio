export class ReviewServerSupervisor {
  private readonly sessions = new Map<string, ActiveReviewServer>();

  async start(runId: string, workspaceRoot: string): Promise<ReviewServerSession | null> {
    const root = realpathSync(workspaceRoot);
    const declaration = readDeclaration(root);
    if (!declaration) return null;
    if (this.sessions.has(runId)) return this.sessions.get(runId)!.session;
    const identity = await requireCleanGitIdentity(root);
    const port = await availablePort();
    const active = launchReviewServer(runId, root, identity.head, port);
    this.sessions.set(runId, active);
    try {
      await requireHealthy(active);
      log("review_server_healthy", active.session);
      return active.session;
    } catch (error) {
      await this.stop(runId);
      throw error;
    }
  }

  async stop(runId: string): Promise<void> {
    const active = this.sessions.get(runId);
    if (!active) return;
    this.sessions.delete(runId);
    await terminate(active.child);
    log("review_server_stopped", { runId, pid: active.session.pid, url: active.session.url });
  }
}

function readDeclaration(root: string): { script: "workbench" } | null {
  const packagePath = join(root, "package.json");
  if (!existsSync(packagePath)) return null;
  const value = JSON.parse(readFileSync(packagePath, "utf8")) as PackageManifest;
  return typeof value.scripts?.workbench === "string" && value.scripts.workbench.trim()
    ? { script: "workbench" }
    : null;
}

async function requireCleanGitIdentity(root: string): Promise<{ head: string }> {
  const head = (await execGit(root, ["rev-parse", "HEAD"])).trim();
  const status = (await execGit(root, ["status", "--porcelain"])).trim();
  if (status) throw new Error("Review server requires a clean committed workspace head.");
  return { head };
}

function launchReviewServer(
  runId: string,
  cwd: string,
  gitHead: string,
  port: number,
): ActiveReviewServer {
  const args = ["run", "workbench"];
  const child = spawn("npm", args, {
    cwd, detached: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), AXI_FACTORIO_REVIEW_PORT: String(port) },
  });
  const session = { runId, url: `http://127.0.0.1:${port}/`, cwd, gitHead, pid: child.pid ?? -1, command: "npm", args };
  const active = { child, session, output: "" };
  child.stdout?.on("data", (chunk) => active.output = tail(active.output, chunk));
  child.stderr?.on("data", (chunk) => active.output = tail(active.output, chunk));
  log("review_server_started", session);
  return active;
}

async function requireHealthy(active: ActiveReviewServer): Promise<void> {
  const deadline = Date.now() + healthTimeoutMs;
  while (Date.now() < deadline) {
    if (active.child.exitCode !== null) throw launchFailure(active);
    if (await isHealthy(active.session.url)) return;
    await pause(healthPollMs);
  }
  throw new Error(`Review server health timed out at ${active.session.url}: ${active.output.trim()}`);
}

async function isHealthy(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(healthRequestMs) });
    return response.ok;
  } catch {
    return false;
  }
}

function launchFailure(active: ActiveReviewServer): Error {
  return new Error(`Review server exited before health at ${active.session.url}: ${active.output.trim()}`);
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
      if (!address || typeof address === "string") return server.close(() => rejectPort(new Error("Could not allocate a review port.")));
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

function isGone(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ESRCH";
}

function tail(current: string, chunk: unknown): string {
  return `${current}${String(chunk)}`.slice(-8_000);
}

function pause(milliseconds: number): Promise<void> {
  return new Promise((resolvePause) => setTimeout(resolvePause, milliseconds));
}

export type ReviewServerSession = {
  runId: string;
  url: string;
  cwd: string;
  gitHead: string;
  pid: number;
  command: "npm";
  args: ["run", "workbench"] | string[];
};
type ActiveReviewServer = { child: ChildProcess; session: ReviewServerSession; output: string };
type PackageManifest = { scripts?: Record<string, unknown> };

const healthTimeoutMs = 12_000;
const healthPollMs = 100;
const healthRequestMs = 500;
const terminationMs = 1_000;

import type { ChildProcess } from "node:child_process";
import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createServer } from "node:net";
import { once } from "node:events";
import { join } from "node:path";
import { log } from "./Logger.ts";
