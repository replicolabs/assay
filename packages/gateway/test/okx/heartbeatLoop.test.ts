import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startHeartbeatLoop } from "../../src/okx/heartbeatLoop.js";
import type { OnchainosClient } from "../../src/okx/onchainosClient.js";

function fakeClient() {
  const calls: number[] = [];
  const client = {
    heartbeat: vi.fn(async (chainIndex: number) => {
      calls.push(chainIndex);
    })
  } as unknown as OnchainosClient;
  return { client, calls };
}

describe("startHeartbeatLoop", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("beats immediately on start, then again on each interval tick", async () => {
    const { client, calls } = fakeClient();
    const stop = startHeartbeatLoop(client, 196, 1000);

    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual([196]);

    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toEqual([196, 196]);

    await vi.advanceTimersByTimeAsync(2000);
    expect(calls).toEqual([196, 196, 196, 196]);

    stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls).toHaveLength(4);
  });

  it("a rejected heartbeat doesn't stop the loop", async () => {
    const client = { heartbeat: vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValue(undefined) } as unknown as OnchainosClient;
    const stop = startHeartbeatLoop(client, 196, 1000);

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(client.heartbeat).toHaveBeenCalledTimes(2);

    stop();
  });
});
