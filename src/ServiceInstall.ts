export function startServiceViewer(
  databasePath: string,
  port: number,
  controller: AbortController,
): Promise<void> {
  const server = createViewerServer(databasePath);
  return new Promise((resolveViewer, rejectViewer) => {
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      error ? rejectViewer(error) : resolveViewer();
    };
    const stop = (): void => server.close((error) => {
      if (error && error.code !== "ERR_SERVER_NOT_RUNNING") finish(error);
      else finish();
    });
    server.once("error", (error) => {
      if (!controller.signal.aborted) controller.abort(error);
      finish(error);
    });
    controller.signal.addEventListener("abort", stop, { once: true });
    server.listen(port, "127.0.0.1", () => log("viewer.ready", {
      databasePath, ownership: "launchd-service", pid: process.pid,
      url: `http://127.0.0.1:${port}`,
    }));
  });
}

export function installService(
  databasePath: string,
  port: number,
  harness: string,
  instrumentation: string,
): ServiceStatus {
  const paths = servicePaths();
  mkdirSync(dirname(paths.plist), { recursive: true });
  mkdirSync(paths.logs, { recursive: true });
  writeFileSync(paths.plist, renderPlist(
    paths, resolve(databasePath), port, harness, instrumentation,
  ));
  bootout(paths);
  execFileSync("launchctl", ["bootstrap", domain(), paths.plist], { stdio: "inherit" });
  execFileSync("launchctl", ["kickstart", "-k", `${domain()}/${label}`], { stdio: "inherit" });
  log("service.installed", { plist: paths.plist, url: `http://127.0.0.1:${port}` });
  return { label, state: "running", pid: null, url: `http://127.0.0.1:${port}`, harness };
}

export function showServiceStatus(): ServiceStatus {
  const output = execFileSync("launchctl", ["print", `${domain()}/${label}`], { encoding: "utf8" });
  const port = output.match(/--port\s+(\d+)/)?.[1] ?? "4317";
  return {
    label,
    state: output.match(/^\s*state = (.+)$/m)?.[1] ?? "unknown",
    pid: numberMatch(output, /^\s*pid = (\d+)$/m),
    url: `http://127.0.0.1:${port}`,
    harness: output.match(/--harness\s+(\S+)/)?.[1] ?? "codex",
  };
}

export function uninstallService(): ServiceStatus {
  const paths = servicePaths();
  bootout(paths);
  rmSync(paths.plist, { force: true });
  log("service.uninstalled", { plist: paths.plist });
  return { label, state: "uninstalled", pid: null, url: null, harness: null };
}

function renderPlist(
  paths: ServicePaths,
  databasePath: string,
  port: number,
  harness: string,
  instrumentation: string,
): string {
  const argumentsList = [
    process.execPath, cliPath, "service", "run",
    "--db", databasePath, "--port", String(port),
    "--harness", harness, "--instrumentation", instrumentation,
  ].map((value) => `    <string>${escapeXml(value)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array>
${argumentsList}
  </array>
  <key>WorkingDirectory</key><string>${escapeXml(process.cwd())}</string>
  <key>ProcessType</key><string>Background</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>${escapeXml(servicePath())}</string>
    <key>AXI_FACTORIO_SERVICE_ID</key><string>${label}</string>
    <key>AXI_FACTORIO_SOURCE_REVISION</key><string>${packageVersion()}</string>
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
    logs: join(home, "Library", "Logs", label),
  };
}

export function servicePath(cwd = process.cwd(), executable = process.execPath): string {
  const localBin = join(cwd, "node_modules", ".bin");
  const codexBin = existsSync(join(localBin, "codex"))
    ? localBin
    : dirname(toolPath("codex"));
  return [dirname(executable), codexBin, "/usr/bin", "/bin"].join(":");
}

function toolPath(name: string): string {
  return execFileSync("which", [name], { encoding: "utf8" }).trim();
}

function packageVersion(): string {
  const path = packagePaths.find((candidate) => existsSync(candidate));
  if (!path) return "unknown";
  const value = JSON.parse(readFileSync(path, "utf8")) as { version?: string };
  return value.version ?? "unknown";
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

function numberMatch(value: string, pattern: RegExp): number | null {
  const match = value.match(pattern)?.[1];
  return match ? Number(match) : null;
}

type ServicePaths = { plist: string; logs: string };
export type ServiceStatus = {
  label: string;
  state: string;
  pid: number | null;
  url: string | null;
  harness: string | null;
};

const label = "me.oljaca.axi-factorio";
const xmlCharacters: Record<string, string> = {
  "\"": "&quot;", "&": "&amp;", "'": "&apos;", "<": "&lt;", ">": "&gt;",
};
const cliPath = fileURLToPath(new URL("./cli.ts", import.meta.url));
const packagePaths = [
  fileURLToPath(new URL("../package.json", import.meta.url)),
  fileURLToPath(new URL("../../package.json", import.meta.url)),
];

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "./Logger.ts";
import { createViewerServer } from "./ViewerServer.ts";
