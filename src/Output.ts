export function printOutput(value: unknown, json = false): void {
  const output = json ? JSON.stringify(value) : encode(value);
  process.stdout.write(`${output}\n`);
}

import { encode } from "@toon-format/toon";
