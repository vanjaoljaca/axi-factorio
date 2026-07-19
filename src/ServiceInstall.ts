export function startServiceViewer(
  databasePath: string,
  port: number,
  controller: AbortController,
): Promise<void> {
  const child = spawn(process.execPath, [
    viewerPath, "--database-only", "--db", databasePath, "--port", String(port),
  ], { cwd: process.cwd(), stdio: "inherit" });
  controller.signal.addEventListener("abort", () => child.kill("SIGTERM"), { once: true });
  return childResult(child, controller);
}

export function installService(databasePath: string, port: number): void {
  const paths = servicePaths();
  mkdirSync(dirname(paths.plist), { recursive: true });
  mkdirSync(paths.logs, { recursive: true });
  writeFileSync(paths.plist, renderPlist(paths, resolve(databasePath), port));
  bootout(paths);
  execFileSync("launchctl", ["bootstrap", domain(), paths.plist], { stdio: "inherit" });
  execFileSync("launchctl", ["kickstart", "-k", `${domain()}/${label}`], { stdio: "inherit" });
  log("service.installed", { plist: paths.plist, url: `http://127.0.0.1:${port}` });
}

export function showServiceStatus(): void {
  process.stdout.write(execFileSync("launchctl", ["print", `${domain()}/${label}`], {
    encoding: "utf8",
  }));
}

export function uninstallService(): void {
  const paths = servicePaths();
  bootout(paths);
  log("service.uninstalled", { plist: paths.plist });
}

function childResult(child: ChildProcess, controller: AbortController): Promise<void> {
  return new Promise((resolve, reject) => child.once("exit", (code, signal) => {
    if (controller.signal.aborted || signal === "SIGTERM") return resolve();
    controller.abort(new Error(`Viewer exited with code ${code}.`));
    reject(new Error(`Viewer exited unexpectedly with code ${code}.`));
  }));
}

function renderPlist(paths: ServicePaths, databasePath: string, port: number): string {
  const argumentsList = [
    npxPath(), "--no-install", "axi-factorio", "service", "run",
    "--db", databasePath, "--port", String(port),
  ].map((value) => `    <string>${escapeXml(value)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array>
${argumentsList}
  </array>
  <key>WorkingDirectory</key><string>${escapeXml(process.cwd())}</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>${escapeXml(servicePath())}</string>
  </dict>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>3</integer>
  <key>StandardOutPath</key><string>${escapeXml(join(paths.logs, "stdout.log"))}</string>
  <key>StandardErrorPath</key><string>${escapeXml(join(paths.logs, "stderr.log"))}</string>
</dict></plist>
`;
}

function servicePaths(): ServicePaths {
  const home = homedir();
  return {
    plist: join(home, "Library", "LaunchAgents", `${label}.plist`),
    logs: join(home, "Library", "Logs", "axi-factorio"),
  };
}

function npxPath(): string {
  return execFileSync("which", ["npx"], { encoding: "utf8" }).trim();
}

function servicePath(): string {
  return [dirname(process.execPath), dirname(npxPath()), "/usr/bin", "/bin"].join(":");
}

function domain(): string {
  const uid = execFileSync("id", ["-u"], { encoding: "utf8" }).trim();
  return `gui/${uid}`;
}

function bootout(paths: ServicePaths): void {
  try {
    execFileSync("launchctl", ["bootout", domain(), paths.plist], { stdio: "ignore" });
  } catch {
    // The service may not be installed.
  }
}

function escapeXml(value: string): string {
  return value.replace(/[<>&"']/gu, (character) => xmlCharacters[character]);
}

function log(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ event, ...fields, at: new Date().toISOString() }));
}

type ServicePaths = { plist: string; logs: string };

const label = "me.oljaca.axi-factorio";
const xmlCharacters: Record<string, string> = {
  "\"": "&quot;", "&": "&amp;", "'": "&apos;", "<": "&lt;", ">": "&gt;",
};
const viewerPath = fileURLToPath(new URL("./WorkbenchServer.ts", import.meta.url));

import type { ChildProcess } from "node:child_process";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
