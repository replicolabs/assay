import type { OnchainosClient } from "./onchainosClient.js";

/**
 * Keeps our OKX.AI agent identity marked online. `agent heartbeat` is
 * documented as "auto-scheduled by runtime", which describes an interactive
 * CLI session's own host process — it does nothing for us, since every call
 * here is a one-shot child_process invocation. Without this loop, nothing
 * ever reports our presence: live-verified, ASP 5586 sat at onlineStatus:2
 * (offline) for ~13h with a stale lastOnlineTime, which lines up with OKX's
 * own listing-rejection reason ("unable to receive a response from your
 * Agent, causing the task to time out").
 *
 * 3-minute interval: no documented threshold for going offline, so this is a
 * conservative cadence — cheap, and comfortably inside any reasonable window.
 */
const DEFAULT_INTERVAL_MS = 3 * 60 * 1000;

export function startHeartbeatLoop(client: OnchainosClient, chainIndex: number, intervalMs = DEFAULT_INTERVAL_MS): () => void {
  const beat = () => {
    client.heartbeat(chainIndex).catch((err) => {
      // A missed heartbeat isn't fatal — the next tick retries — but stay
      // loud about it, since a silent failure here is exactly how we ended
      // up offline in the first place.
      // eslint-disable-next-line no-console
      console.error("[heartbeat] failed:", err);
    });
  };

  beat();
  const timer = setInterval(beat, intervalMs);
  return () => clearInterval(timer);
}
