import { readFile, writeFile } from "node:fs/promises";

import type { RunState } from "./state-types.js";

export async function writeState(filePath: string, state: RunState): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export async function readState(filePath: string): Promise<RunState> {
  const raw = await readFile(filePath, "utf8");
  return JSON.parse(raw) as RunState;
}

