import { describe, expect, it } from "vitest";
import { OnchainosClient } from "../../src/okx/onchainosClient.js";

const client = new OnchainosClient();

describe("reputation ingestion (against the fake CLI)", () => {
  it("returns feedback items with 0-5 scores and stable dedupe keys", async () => {
    const items = await client.listFeedback("1002");
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.taskHash ?? item.taskId).toBeTruthy();
      expect(item.score).toBeGreaterThanOrEqual(0);
      expect(item.score).toBeLessThanOrEqual(5);
    }
  });

  it("agent with no reviews returns an empty list, not an error", async () => {
    const items = await client.listFeedback("1004");
    expect(items).toEqual([]);
  });
});
