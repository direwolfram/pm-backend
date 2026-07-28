import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import { internal } from "../convex/_generated/api";
import schema from "../convex/schema";

const modules = import.meta.glob("../convex/**/*.ts");

describe("quick inventory shelf-life refresh", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T15:30:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("patches only changed unexpired batches and skips expired history", async () => {
    const t = convexTest({ schema, modules });
    await t.run(async (ctx) => {
      const inventoryId = await ctx.db.insert("inventory", {
        sku: "Q-SHELF",
        productId: undefined,
        fulfillmentCenterId: undefined,
        availableQuantity: 1,
        reservedQuantity: 0,
        maxOrderQuantity: 1,
        replenishmentThreshold: 1,
      });
      await ctx.db.insert("batches", {
        inventoryId,
        batchNumber: "UNCHANGED",
        quantity: 1,
        expiryDate: Date.parse("2026-01-03T00:00:00+08:00"),
        shelfLifeDaysRemaining: 2,
        isNearExpiry: true,
        discountPercent: 0,
        qualityCheckStatus: "passed",
        pickPriority: -Date.parse("2026-01-03T00:00:00+08:00"),
      });
      await ctx.db.insert("batches", {
        inventoryId,
        batchNumber: "CHANGED",
        quantity: 1,
        expiryDate: Date.parse("2026-01-06T00:00:00+08:00"),
        shelfLifeDaysRemaining: 10,
        isNearExpiry: false,
        discountPercent: 0,
        qualityCheckStatus: "passed",
        pickPriority: -1,
      });
      await ctx.db.insert("batches", {
        inventoryId,
        batchNumber: "EXPIRED",
        quantity: 0,
        expiryDate: Date.parse("2026-01-02T00:00:00+08:00"),
        shelfLifeDaysRemaining: 0,
        isNearExpiry: true,
        discountPercent: 0,
        qualityCheckStatus: "failed",
        pickPriority: -Date.parse("2026-01-02T00:00:00+08:00"),
        expiredAt: Date.now(),
      });
    });

    await expect(
      t.mutation(internal.quickInventory.updateShelfLife, { limit: 100 }),
    ).resolves.toMatchObject({
      processed: 2,
      patched: 1,
      remainingMayExist: false,
      timezone: "Asia/Manila",
    });
    await expect(
      t.mutation(internal.quickInventory.updateShelfLife, { limit: 100 }),
    ).resolves.toMatchObject({ processed: 2, patched: 0 });
  });
});
