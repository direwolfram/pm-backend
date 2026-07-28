import { describe, expect, it } from "vitest";
import type { Id } from "../convex/_generated/dataModel";
import { listByCenterHandler } from "../convex/quickInventory";
import { doc, FakeConvexDb } from "./fakeConvexDb";

function makeQuickRows(count: number) {
  return Array.from({ length: count }, (_, index) => {
    const n = String(index).padStart(3, "0");
    return doc("inventory", {
      _id: `inv_${n}`,
      sku: `SKU-${n}`,
      productId: `product_${n}`,
      fulfillmentCenterId: "center_a",
      availableQuantity: 20,
      reservedQuantity: 0,
      inboundQuantity: 0,
      maxOrderQuantity: 10,
      replenishmentThreshold: 3,
      lastUpdatedAt: 1,
      isActive: true,
      isLowStock: false,
      isQuickInventory: true,
      quickStatus: "in_stock",
      productName: `Product ${n}`,
      productBrand: "PocketMart",
      fulfillmentCenterName: "Center A",
      pricingSummary:
        index % 2 === 0
          ? {
              _id: `price_${n}`,
              inventoryId: `inv_${n}`,
              dynamicPrice: 100 + index,
              flashSaleReservedQty: 0,
              membershipExclusiveQty: 0,
              isSurgeActive: false,
            }
          : undefined,
      batchCount: index % 3,
      nearExpiryBatchCount: index % 2,
      earliestExpiryDate: index % 3 ? 1000 + index : undefined,
      quickInventorySummaryVersion: 1,
    });
  });
}

describe("quickInventory.listByCenter", () => {
  it("uses inventory summaries and does not query pricing or batches per returned row", async () => {
    const rows = makeQuickRows(120);
    const db = new FakeConvexDb({
      inventory: rows,
      products: rows.map((row) =>
        doc("products", {
          _id: row.productId,
          name: row.productName,
          brand: row.productBrand,
          primary_category_id: "cat",
          slug: row.productName.toLowerCase().replaceAll(" ", "-"),
          status: "active",
          rating_average: 0,
          rating_count: 0,
          attributes: [],
          created_at: 1,
          updated_at: 1,
        }),
      ),
      fulfillmentCenters: [
        doc("fulfillmentCenters", {
          _id: "center_a",
          name: "Center A",
          address: "A",
          latitude: 0,
          longitude: 0,
          serviceablePincodes: [],
          isActive: true,
        }),
      ],
      inventoryPricing: [],
      batches: [],
    });

    const result = await listByCenterHandler(
      { db },
      {
        fulfillmentCenterId:
          "center_a" as Id<"fulfillmentCenters">,
        limit: 5,
      },
    );

    expect(result).toHaveLength(5);
    expect(result.map((row) => row.sku)).toEqual([
      "SKU-000",
      "SKU-001",
      "SKU-002",
      "SKU-003",
      "SKU-004",
    ]);
    expect(result[0].pricing).toMatchObject({ dynamicPrice: 100 });
    expect(result[1].pricing).toBeNull();
    expect(result[2]).toMatchObject({
      batchCount: 2,
      nearExpiryBatchCount: 0,
      earliestExpiryDate: 1002,
    });
    expect(db.stats.get.products).toBeUndefined();
    expect(db.stats.get.fulfillmentCenters).toBeUndefined();
    expect(db.stats.first["inventoryPricing.by_inventory"]).toBeUndefined();
    expect(db.stats.collect["batches.by_inventory_expiry"]).toBeUndefined();
  });

  it("does not fetch every product to apply search", async () => {
    const rows = makeQuickRows(120);
    const db = new FakeConvexDb({
      inventory: rows,
      products: [
        doc("products", {
          _id: "product_099",
          name: "Product 099",
          brand: "PocketMart",
          primary_category_id: "cat",
          slug: "product-099",
          status: "active",
          rating_average: 0,
          rating_count: 0,
          attributes: [],
          created_at: 1,
          updated_at: 1,
        }),
      ],
      fulfillmentCenters: [
        doc("fulfillmentCenters", {
          _id: "center_a",
          name: "Center A",
          address: "A",
          latitude: 0,
          longitude: 0,
          serviceablePincodes: [],
          isActive: true,
        }),
      ],
      inventoryPricing: [],
      batches: [],
    });

    const result = await listByCenterHandler(
      { db },
      {
        fulfillmentCenterId:
          "center_a" as Id<"fulfillmentCenters">,
        search: "Product 099",
        limit: 5,
      },
    );

    expect(result.map((row) => row.sku)).toEqual(["SKU-099"]);
    expect(db.stats.get.products).toBeUndefined();
    expect(db.stats.first["inventoryPricing.by_inventory"]).toBeUndefined();
    expect(db.stats.collect["batches.by_inventory_expiry"]).toBeUndefined();
  });

  it("keeps child query counts constant as page size and unrelated inventory grow", async () => {
    const rows = makeQuickRows(600);
    const unrelated = Array.from({ length: 500 }, (_, index) =>
      doc("inventory", {
        _id: `legacy_${index}`,
        sku_id: `sku_${index}`,
        store_id: "store_a",
        quantity_available: 10,
        quantity_reserved: 0,
        low_stock_threshold: 5,
        status: "in_stock",
        updated_at: 1,
      }),
    );
    const pricingHistory = Array.from({ length: 1000 }, (_, index) =>
      doc("inventoryPricing", {
        _id: `unrelated_price_${index}`,
        inventoryId: `unrelated_inventory_${index}`,
        dynamicPrice: index,
        flashSaleReservedQty: 0,
        membershipExclusiveQty: 0,
        isSurgeActive: false,
      }),
    );
    const batchHistory = Array.from({ length: 1000 }, (_, index) =>
      doc("batches", {
        _id: `unrelated_batch_${index}`,
        inventoryId: `unrelated_inventory_${index}`,
        batchNumber: `B-${index}`,
        quantity: 1,
        expiryDate: index,
        shelfLifeDaysRemaining: 10,
        isNearExpiry: false,
        discountPercent: 0,
        qualityCheckStatus: "passed",
        pickPriority: index,
      }),
    );
    const smallDb = new FakeConvexDb({ inventory: rows, inventoryPricing: [], batches: [] });
    const largeDb = new FakeConvexDb({
      inventory: [...rows, ...unrelated],
      inventoryPricing: pricingHistory,
      batches: batchHistory,
    });

    for (const limit of [5, 50, 500]) {
      await listByCenterHandler(
        { db: limit === 5 ? smallDb : largeDb },
        { fulfillmentCenterId: "center_a" as Id<"fulfillmentCenters">, limit },
      );
    }

    expect(smallDb.stats.first["inventoryPricing.by_inventory"]).toBeUndefined();
    expect(smallDb.stats.collect["batches.by_inventory_expiry"]).toBeUndefined();
    expect(largeDb.stats.first["inventoryPricing.by_inventory"]).toBeUndefined();
    expect(largeDb.stats.collect["batches.by_inventory_expiry"]).toBeUndefined();
    expect(largeDb.stats.collect.inventory).toBeUndefined();
    expect(largeDb.stats.collect["inventory.by_center_active"]).toBe(2);
  });

  it("caps missing-summary product and center fallback to the returned page", async () => {
    const rows = makeQuickRows(120).map((row) => ({
      ...row,
      productName: undefined,
      productBrand: undefined,
      fulfillmentCenterName: undefined,
    }));
    const db = new FakeConvexDb({
      inventory: rows,
      products: rows.slice(0, 5).map((row) =>
        doc("products", {
          _id: row.productId,
          name: `Fallback ${row.sku}`,
          brand: "Fallback",
          primary_category_id: "cat",
          slug: `fallback-${row.sku}`,
          status: "active",
          rating_average: 0,
          rating_count: 0,
          attributes: [],
          created_at: 1,
          updated_at: 1,
        }),
      ),
      fulfillmentCenters: [
        doc("fulfillmentCenters", {
          _id: "center_a",
          name: "Center A",
          address: "A",
          latitude: 0,
          longitude: 0,
          serviceablePincodes: [],
          isActive: true,
        }),
      ],
    });

    const result = await listByCenterHandler(
      { db },
      { fulfillmentCenterId: "center_a" as Id<"fulfillmentCenters">, limit: 5 },
    );

    expect(result).toHaveLength(5);
    expect(db.stats.get.products).toBe(5);
    expect(db.stats.get.fulfillmentCenters).toBe(1);
  });
});
