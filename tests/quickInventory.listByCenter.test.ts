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
      productName: `Product ${n}`,
      productBrand: "PocketMart",
      fulfillmentCenterName: "Center A",
    });
  });
}

describe("quickInventory.listByCenter", () => {
  it("uses inventory summaries for search and limits expensive enrichment to returned rows", async () => {
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
    expect(db.stats.get.products).toBe(5);
    expect(db.stats.get.fulfillmentCenters).toBe(1);
    expect(db.stats.first["inventoryPricing.by_inventory"]).toBe(5);
    expect(db.stats.collect["batches.by_inventory_expiry"]).toBe(5);
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
    expect(db.stats.get.products).toBe(1);
    expect(db.stats.first["inventoryPricing.by_inventory"]).toBe(1);
    expect(db.stats.collect["batches.by_inventory_expiry"]).toBe(1);
  });
});
