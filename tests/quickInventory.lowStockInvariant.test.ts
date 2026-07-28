import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import { api, internal } from "../convex/_generated/api";
import schema from "../convex/schema";
import type { Id } from "../convex/_generated/dataModel";

const modules = import.meta.glob("../convex/**/*.ts");

async function insertInventory(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const categoryId = await ctx.db.insert("categories", {
      name: "Pantry",
      slug: "pantry",
      sort_order: 1,
      is_active: true,
    });
    const productId = await ctx.db.insert("products", {
      sku: "Q-LOW",
      primary_category_id: categoryId,
      name: "Low Stock Fixture",
      slug: "low-stock-fixture",
      status: "active",
      brand: "PocketMart",
      rating_average: 0,
      rating_count: 0,
      attributes: [],
      created_at: Date.now(),
      updated_at: Date.now(),
    });
    const centerId = await ctx.db.insert("fulfillmentCenters", {
      name: "Center A",
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
    const userId = await ctx.db.insert("users", {
      name: "Test User",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const inventoryId = await ctx.db.insert("inventory", {
      sku: "Q-LOW",
      productId,
      fulfillmentCenterId: centerId,
      availableQuantity: 6,
      reservedQuantity: 0,
      inboundQuantity: 0,
      maxOrderQuantity: 10,
      replenishmentThreshold: 5,
      lastUpdatedAt: Date.now(),
      isActive: true,
      isLowStock: false,
      productName: "Low Stock Fixture",
      productBrand: "PocketMart",
      fulfillmentCenterName: "Center A",
    });
    return { inventoryId, userId };
  });
}

async function readInventory(
  t: ReturnType<typeof convexTest>,
  inventoryId: Id<"inventory">,
) {
  return await t.run(async (ctx) => {
    const row = await ctx.db.get(inventoryId);
    if (!row) throw new Error("missing inventory");
    return row;
  });
}

describe("quick inventory low-stock invariant", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("updates isLowStock through reserve, release, and expiry", async () => {
    const t = convexTest({ schema, modules });
    const { inventoryId, userId } = await insertInventory(t);

    const reservation = await t.mutation(api.quickInventory.reserveInventory, {
      inventoryId,
      userId,
      quantity: 2,
    });
    expect(reservation.success).toBe(true);
    await expect(readInventory(t, inventoryId)).resolves.toMatchObject({
      availableQuantity: 6,
      reservedQuantity: 2,
      isLowStock: true,
    });

    await t.mutation(api.quickInventory.releaseReservation, {
      reservationId: reservation.reservationId!,
    });
    await expect(readInventory(t, inventoryId)).resolves.toMatchObject({
      availableQuantity: 6,
      reservedQuantity: 0,
      isLowStock: false,
    });

    const expiring = await t.mutation(api.quickInventory.reserveInventory, {
      inventoryId,
      userId,
      quantity: 2,
    });
    vi.advanceTimersByTime(11 * 60 * 1000);
    await t.mutation(internal.quickInventory.expireCartReservations, {});
    await expect(readInventory(t, inventoryId)).resolves.toMatchObject({
      availableQuantity: 6,
      reservedQuantity: 0,
      isLowStock: false,
    });
    expect(expiring.success).toBe(true);
  });

  it("updates isLowStock through conversion, adjustment, replenish, and batch changes", async () => {
    const t = convexTest({ schema, modules });
    const { inventoryId, userId } = await insertInventory(t);

    const reservation = await t.mutation(api.quickInventory.reserveInventory, {
      inventoryId,
      userId,
      quantity: 2,
    });
    await t.mutation(api.quickInventory.convertReservation, {
      reservationId: reservation.reservationId!,
    });
    await expect(readInventory(t, inventoryId)).resolves.toMatchObject({
      availableQuantity: 4,
      reservedQuantity: 0,
      isLowStock: true,
    });

    await t.mutation(api.quickInventory.updateInventory, {
      inventoryId,
      adjustment: 3,
      reason: "cycle count",
    });
    await expect(readInventory(t, inventoryId)).resolves.toMatchObject({
      availableQuantity: 7,
      isLowStock: false,
    });

    await t.mutation(api.quickInventory.updateInventory, {
      inventoryId,
      adjustment: -3,
      reason: "damage",
    });
    await expect(readInventory(t, inventoryId)).resolves.toMatchObject({
      availableQuantity: 4,
      isLowStock: true,
    });

    const batchId = await t.mutation(api.quickInventory.createBatch, {
      inventoryId,
      batchNumber: "B-1",
      quantity: 3,
      expiryDate: Date.now() + 7 * 24 * 60 * 60 * 1000,
    });
    await expect(readInventory(t, inventoryId)).resolves.toMatchObject({
      availableQuantity: 7,
      isLowStock: false,
    });

    await t.mutation(api.quickInventory.markBatchExpired, { batchId });
    await expect(readInventory(t, inventoryId)).resolves.toMatchObject({
      availableQuantity: 4,
      isLowStock: true,
    });

    await t.mutation(api.quickInventory.replenishStock, {
      inventoryId,
      quantity: 2,
    });
    await expect(readInventory(t, inventoryId)).resolves.toMatchObject({
      availableQuantity: 6,
      isLowStock: false,
    });
  });

  it("backfills quick inventory pricing and batch summaries in bounded chunks", async () => {
    const t = convexTest({ schema, modules });
    const { inventoryId } = await insertInventory(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(inventoryId, {
        pricingSummary: undefined,
        batchCount: undefined,
        nearExpiryBatchCount: undefined,
        earliestExpiryDate: undefined,
        quickInventorySummaryVersion: undefined,
      });
      await ctx.db.insert("inventoryPricing", {
        inventoryId,
        dynamicPrice: 123,
        flashSaleReservedQty: 1,
        membershipExclusiveQty: 2,
        isSurgeActive: true,
      });
      await ctx.db.insert("batches", {
        inventoryId,
        batchNumber: "BACKFILL-1",
        quantity: 1,
        expiryDate: Date.now() + 24 * 60 * 60 * 1000,
        shelfLifeDaysRemaining: 1,
        isNearExpiry: true,
        discountPercent: 0,
        qualityCheckStatus: "passed",
        pickPriority: 1,
      });
    });

    await expect(
      t.mutation(api.quickInventory.backfillInventorySummaries, {
        limit: 1,
      }),
    ).resolves.toMatchObject({ processed: 1, remainingMayExist: true });
    await expect(readInventory(t, inventoryId)).resolves.toMatchObject({
      pricingSummary: { dynamicPrice: 123, isSurgeActive: true },
      batchCount: 1,
      nearExpiryBatchCount: 1,
      earliestExpiryDate: Date.now() + 24 * 60 * 60 * 1000,
      quickInventorySummaryVersion: 1,
    });
    await expect(
      t.mutation(api.quickInventory.backfillInventorySummaries, {
        limit: 1,
      }),
    ).resolves.toMatchObject({ processed: 0, remainingMayExist: false });
  });
});
