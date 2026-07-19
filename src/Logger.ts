export function log(event: string, fields: Record<string, unknown> = {}): void {
  const record = { at: new Date().toISOString(), component: "axi-factorio", event, ...fields };
  process.stderr.write(`${JSON.stringify(record)}\n`);
}
