export const DEFAULT_VIEWER_PORT = 4317;
export const DEFAULT_WORKBENCH_PORT = 4318;

export function workbenchPort(arguments_: string[]): number {
  const port = portArgument(arguments_, "--port", DEFAULT_WORKBENCH_PORT);
  const viewerPort = portArgument(arguments_, "--viewer-port", DEFAULT_VIEWER_PORT);
  if (port === viewerPort) throw new Error(`Workbench port ${port} conflicts with the user viewer port.`);
  return port;
}

function portArgument(arguments_: string[], name: string, fallback: number): number {
  const index = arguments_.indexOf(name);
  const value = index < 0 ? fallback : Number(arguments_[index + 1]);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${name} must be an integer from 1 to 65535.`);
  }
  return value;
}
