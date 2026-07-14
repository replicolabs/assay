import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
// packages/gateway/src/okx -> packages/gateway/test/fakes/onchainos
const FAKE_BIN_PATH = path.resolve(here, "..", "..", "test", "fakes", "onchainos");

export type OnchainosMode = "fake" | "live";

export interface OnchainosConfig {
  mode: OnchainosMode;
  /** Absolute path (or PATH-resolvable name) of the binary child_process actually spawns. */
  bin: string;
  timeoutMs: number;
}

/**
 * Single place that decides which binary gets spawned. Everything downstream
 * (onchainosClient.ts and all callers) is identical between fake and live —
 * per the plan, flipping ONCHAINOS_MODE is the only change needed to go live.
 */
export function loadOnchainosConfig(env: NodeJS.ProcessEnv = process.env): OnchainosConfig {
  const mode: OnchainosMode = env.ONCHAINOS_MODE === "live" ? "live" : "fake";
  const bin = mode === "fake" ? FAKE_BIN_PATH : env.ONCHAINOS_BIN?.trim() || "onchainos";
  const timeoutMs = Number(env.ONCHAINOS_TIMEOUT_MS ?? 30_000);
  return { mode, bin, timeoutMs };
}
