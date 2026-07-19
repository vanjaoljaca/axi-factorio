export interface ToolAdapter {
  readonly name: string;
  execute(input: AdapterInput, onExternalRun: ExternalRunHandler): Promise<AdapterResult>;
}

export type ExternalRunHandler = (externalRunId: string) => void;

import type { AdapterInput, AdapterResult } from "./Types.ts";
