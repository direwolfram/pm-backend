import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import { api, internal } from "../convex/_generated/api";
import schema from "../convex/schema";
import type { Id } from "../convex/_generated/dataModel";

const modules = import.meta.glob("../convex/**/*.ts");

async function insertQuickInventory(t: ReturnType<typeof convexTest>, available = 10) {
  return await t.run(async (ctx) => {
    const categoryId = await ctx.db.insert("categories", {
      name: "Cat",
      slug: `cat-${Math.random()}`,
      sort_order: 1,
      is_active: true,
    });
    const productId = await ctx.db.insert("products", {
      primary_category_id: categoryId,
      name: "Shelf Product",
      slug: `shelf-product-${Math.random()}`,
      status: "active",
      rating_average: 0,
      rating_count: 0,
      attributes: [],
      created_at: 1,
      updated_at: 1,
    });
    const centerId = await ctx.db.insert("fulfillmentCenters", {
      name: "Center",
      address: "A",
      latitude: 0,
      longitude: 0,
      serviceablePincodes: [],
      zoneIds: [],
      isActive: true,
      operatingHours: { open: 6, close: 23 },
      capacity: 100,
      coldChainEnabled: false,
    });
    const inventoryId = await ctx.db.insert("inventory", {
      sku: "Q-SHELF-LIFE",
      productId,
      fulfillmentCenterId: centerId,
      availableQuantity: available,
      reservedQuantity: 0,
      maxOrderQuantity: 100,
      replenishmentThreshold: 1,
      lastUpdatedAt: Date.now(),
      isActive: true,
      isQuickInventory: true,
    });
    return inventoryId;
  });
}

async function getBatch(t: ReturnType<typeof convexTest>, batchId: Id<"batches">) {
  return await t.run(async (ctx) => await ctx.db.get(batchId));
}

async function getInventory(
  t: ReturnType<typeof convexTest>,
  inventoryId: Id<"inventory">,
) {
  return await t.run(async (ctx) => await ctx.db.get(inventoryId));
}

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
        nextShelfLifeRefreshAt: Date.now() - 1,
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
        nextShelfLifeRefreshAt: Date.now() - 1,
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
      patched: 2,
      remainingMayExist: false,
      timezone: "Asia/Manila",
    });
    await expect(
      t.mutation(internal.quickInventory.updateShelfLife, { limit: 100 }),
    ).resolves.toMatchObject({ processed: 0, patched: 0 });
  });

  it("continues through more than 100 batches with the same expiry timestamp", async () => {
    const t = convexTest({ schema, modules });
    await t.run(async (ctx) => {
      const inventoryId = await ctx.db.insert("inventory", {
        sku: "Q-SAME",
        availableQuantity: 1,
        reservedQuantity: 0,
        maxOrderQuantity: 1,
        replenishmentThreshold: 1,
      });
      const expiryDate = Date.parse("2026-01-06T00:00:00+08:00");
      for (let index = 0; index < 101; index += 1) {
        await ctx.db.insert("batches", {
          inventoryId,
          batchNumber: `SAME-${index}`,
          quantity: 1,
          expiryDate,
          shelfLifeDaysRemaining: 99,
          isNearExpiry: false,
          discountPercent: 0,
          qualityCheckStatus: "passed",
          pickPriority: 0,
          nextShelfLifeRefreshAt: Date.now() - 1,
        });
      }
    });

    const first = await t.mutation(internal.quickInventory.updateShelfLife, {
      limit: 100,
    });
    const second = await t.mutation(internal.quickInventory.updateShelfLife, {
      limit: 100,
      cursor: first.nextCursor,
      evaluatedAt: Date.now(),
    });

    expect(first).toMatchObject({ processed: 100, remainingMayExist: true });
    expect(second).toMatchObject({ processed: 1, remainingMayExist: false });
  });

  it("auto-expires past-due batches exactly once under duplicate runs", async () => {
    const t = convexTest({ schema, modules });
    const inventoryId = await insertQuickInventory(t, 8);
    const batchId = await t.mutation(api.quickInventory.createBatch, {
      inventoryId,
      batchNumber: "PAST-DUE",
      quantity: 5,
      expiryDate: Date.parse("2025-12-31T00:00:00+08:00"),
    });
    await expect(getInventory(t, inventoryId)).resolves.toMatchObject({
      availableQuantity: 13,
    });
    // The batch is due for evaluation at the next Manila midnight refresh;
    // mark it due now to simulate that refresh.
    await t.run(async (ctx) => {
      await ctx.db.patch(batchId, {
        nextShelfLifeRefreshAt: Date.now() - 1,
      });
    });

    // Two overlapping root runs before draining continuations: the shared
    // expireBatch guard must decrement inventory exactly once.
    await t.mutation(internal.quickInventory.updateShelfLife, { limit: 100 });
    await t.mutation(internal.quickInventory.updateShelfLife, { limit: 100 });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    await expect(getBatch(t, batchId)).resolves.toMatchObject({
      quantity: 0,
      qualityCheckStatus: "failed",
    });
    const batch = await getBatch(t, batchId);
    expect(batch?.nextShelfLifeRefreshAt).toBeUndefined();
    expect(batch?.expiredAt).toBeDefined();
    await expect(getInventory(t, inventoryId)).resolves.toMatchObject({
      availableQuantity: 8,
    });

    // A later run is a no-op.
    const rerun = await t.mutation(internal.quickInventory.updateShelfLife, {
      limit: 100,
    });
    expect(rerun).toMatchObject({ processed: 0, expired: 0 });
    await expect(getInventory(t, inventoryId)).resolves.toMatchObject({
      availableQuantity: 8,
    });
  });

  it("keeps expiry-day batches sellable and skips far-future batches", async () => {
    const t = convexTest({ schema, modules });
    const inventoryId = await insertQuickInventory(t, 1);
    const expiryDayBatch = await t.mutation(api.quickInventory.createBatch, {
      inventoryId,
      batchNumber: "EXPIRES-TODAY",
      quantity: 1,
      // expires today in Manila (2026-01-01 12:00 +08:00 = 04:00Z)
      expiryDate: Date.parse("2026-01-01T12:00:00+08:00"),
    });
    const farFutureBatch = await t.mutation(api.quickInventory.createBatch, {
      inventoryId,
      batchNumber: "FAR-FUTURE",
      quantity: 1,
      expiryDate: Date.parse("2026-02-01T00:00:00+08:00"),
    });

    // Force the far-future batch's marker into the past to prove selection is
    // marker-driven, then restore a correct marker via backfill semantics.
    await t.run(async (ctx) => {
      await ctx.db.patch(farFutureBatch, {
        nextShelfLifeRefreshAt: Date.now() + 365 * 86_400_000,
      });
    });

    const result = await t.mutation(internal.quickInventory.updateShelfLife, {
      limit: 100,
    });
    expect(result.expired).toBe(0);

    const expiryDay = await getBatch(t, expiryDayBatch);
    expect(expiryDay?.expiredAt).toBeUndefined();
    expect(expiryDay?.shelfLifeDaysRemaining).toBe(0);
    expect(expiryDay?.isNearExpiry).toBe(true);
    const farFuture = await getBatch(t, farFutureBatch);
    expect(farFuture?.expiredAt).toBeUndefined();
  });

  it("clears the refresh marker on manual expiration", async () => {
    const t = convexTest({ schema, modules });
    const inventoryId = await insertQuickInventory(t, 4);
    const batchId = await t.mutation(api.quickInventory.createBatch, {
      inventoryId,
      batchNumber: "MANUAL",
      quantity: 2,
      expiryDate: Date.now() + 30 * 86_400_000,
    });

    await t.mutation(api.quickInventory.markBatchExpired, { batchId });
    const batch = await getBatch(t, batchId);
    expect(batch?.expiredAt).toBeDefined();
    expect(batch?.nextShelfLifeRefreshAt).toBeUndefined();

    // not picked up by the due query anymore
    const result = await t.mutation(internal.quickInventory.updateShelfLife, {
      limit: 100,
    });
    expect(result.processed).toBe(0);
  });

  it("backfills refresh markers across pages with one evaluation timestamp", async () => {
    const t = convexTest({ schema, modules });
    await t.run(async (ctx) => {
      const inventoryId = await ctx.db.insert("inventory", {
        sku: "Q-MARKERS",
        availableQuantity: 1,
        reservedQuantity: 0,
        maxOrderQuantity: 1,
        replenishmentThreshold: 1,
      });
      for (let index = 0; index < 150; index += 1) {
        await ctx.db.insert("batches", {
          inventoryId,
          batchNumber: `M-${index}`,
          quantity: 1,
          expiryDate: Date.parse("2026-02-01T00:00:00+08:00") + index,
          shelfLifeDaysRemaining: 99,
          isNearExpiry: false,
          discountPercent: 0,
          qualityCheckStatus: "passed",
          pickPriority: 0,
        });
      }
    });

    const evaluatedAt = Date.now();
    const first = await t.mutation(
      internal.quickInventory.backfillShelfLifeRefreshMarkers,
      { limit: 100, evaluatedAt },
    );
    expect(first).toMatchObject({ processed: 100, remainingMayExist: true });
    const second = await t.mutation(
      internal.quickInventory.backfillShelfLifeRefreshMarkers,
      { limit: 100, cursor: first.nextCursor, evaluatedAt },
    );
    expect(second).toMatchObject({ processed: 50, remainingMayExist: false });
    expect(first.patched + second.patched).toBe(150);

    // All markers derived from the same evaluation timestamp: next Manila
    // midnight after 2026-01-01T15:30:00Z is 2026-01-02T00:00:00+08:00.
    const expectedMarker = Date.parse("2026-01-02T00:00:00+08:00");
    const markers = await t.run(async (ctx) =>
      (await ctx.db.query("batches").collect()).map(
        (batch) => batch.nextShelfLifeRefreshAt,
      ),
    );
    expect(new Set(markers)).toEqual(new Set([expectedMarker]));

    // no-change rerun
    const rerun = await t.mutation(
      internal.quickInventory.backfillShelfLifeRefreshMarkers,
      { limit: 100, evaluatedAt },
    );
    expect(rerun.patched).toBe(0);
  });
});
