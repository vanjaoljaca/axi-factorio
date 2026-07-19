const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const releaseDirectory = join(root, "release");
const packageMetadata = readPackageMetadata();
const archiveName = `${packageMetadata.name}-${packageMetadata.version}.tgz`;
const archivePath = join(releaseDirectory, archiveName);

buildRelease();

function buildRelease(): void {
  buildDistribution();
  rmSync(releaseDirectory, { recursive: true, force: true });
  mkdirSync(releaseDirectory, { recursive: true });
  execFileSync("npm", ["pack", "--pack-destination", releaseDirectory], {
    cwd: root, stdio: "inherit",
  });
  writeFileSync(join(releaseDirectory, "SHA256SUMS"), checksum());
  writeFileSync(join(releaseDirectory, "INSTALL.md"), installationGuide());
  log("release.built", { archivePath, version: packageMetadata.version });
}

function buildDistribution(): void {
  const distribution = join(root, "dist");
  rmSync(distribution, { recursive: true, force: true });
  compileDirectory(join(root, "src"), join(distribution, "src"));
  chmodSync(join(distribution, "src", "cli.js"), 0o755);
}

function compileDirectory(source: string, destination: string): void {
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (entry.name === "WorkbenchServer.ts") continue;
    const input = join(source, entry.name);
    const output = join(destination, entry.name.replace(/\.ts$/, ".js"));
    if (entry.isDirectory()) compileDirectory(input, output);
    else if (entry.name.endsWith(".ts")) compileTypeScript(input, output);
    else copyFileSync(input, output);
  }
}

function compileTypeScript(input: string, output: string): void {
  const source = readFileSync(input, "utf8");
  const javascript = stripTypeScriptTypes(source, { mode: "transform" })
    .replace(/\.ts(["'])/g, ".js$1");
  writeFileSync(output, javascript);
}

function readPackageMetadata(): PackageMetadata {
  const content = readFileSync(join(root, "package.json"), "utf8");
  return JSON.parse(content) as PackageMetadata;
}

function checksum(): string {
  const digest = createHash("sha256").update(readFileSync(archivePath)).digest("hex");
  return `${digest}  ${archiveName}\n`;
}

function installationGuide(): string {
  return `# Install axi-factorio ${packageMetadata.version}

Requires Node.js 23.6 or newer.

## Direct local install

From the consuming project:

\`\`\`sh
npm install --save-exact /absolute/path/to/axi-factorio/release/${archiveName}
npx axi-factorio --version
\`\`\`

## Recommended repository-pinned install

Copy the archive into the consuming repository, then install that copy:

\`\`\`sh
mkdir -p vendor/axi-factorio
cp /absolute/path/to/axi-factorio/release/${archiveName} vendor/axi-factorio/
npm install --save-exact ./vendor/axi-factorio/${archiveName}
npx axi-factorio --version
\`\`\`

Commit the archive, \`package.json\`, and lockfile together. This makes the
exact release candidate reproducible without \`npm link\` or an unpublished
registry version.

## Configure app projects

\`\`\`sh
npx axi-factorio project upsert APP_ID "APP NAME" \\
  --root /absolute/path/to/workspace/apps/APP_ID \\
  --pipeline-root /absolute/path/to/workspace/pipelines \\
  --pipeline default
npx axi-factorio project show APP_ID --json
\`\`\`

New blobs use the project root as their Codex working directory and resolve the
highest \`vN\` under the shared pipeline root. Existing rc.4 databases migrate
on first open; use \`project upsert\` to replace the migrated
\`<old-cwd>/pipelines\` root with the shared workspace pipeline root.
`;
}

function log(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ event, ...fields, at: new Date().toISOString() }));
}

type PackageMetadata = { name: string; version: string };

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
