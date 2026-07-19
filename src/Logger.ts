export function log(event: string, fields: Record<string, unknown> = {}): void {
  const record = {
    at: new Date().toISOString(),
    component: "axi-factorio",
    service: process.env.AXI_FACTORIO_SERVICE_ID ?? "axi-factorio",
    pid: process.pid,
    sourceRevision: process.env.AXI_FACTORIO_SOURCE_REVISION ?? "development",
    runtimeRoot: process.cwd(),
    event,
    ...fields,
  };
  process.stderr.write(`${JSON.stringify(record)}\n`);
}
