import { describe, expect, it } from "vitest";
import type { Id } from "../convex/_generated/dataModel";
import {
  listByStoreHandler,
  summaryByStoreHandler,
} from "../convex/inventory";
import { doc, FakeConvexDb } from "./fakeConvexDb";

function legacyInventoryRows(storeId: string, count: number) {
  return Array.from({ length: count }, (_, index) => {
    const n = String(index).padStart(3, "0");
    return doc("inventory", {
      _id: `inv_${storeId}_${n}`,
      sku_id: `sku_${storeId}_${n}`,
      productId: `product_sku_${storeId}_${n}`,
      store_id: storeId,
      quantity_available: index % 4 === 0 ? 0 : 12,
      quantity_reserved: index % 3,
      low_stock_threshold: 5,
      status: index % 4 === 0 ? "out_of_stock" : "in_stock",
      updated_at: 1,
      skuCode: `SKU-${storeId}-${n}`,
      variantLabel: `Variant ${n}`,
      productName: `Item ${n}`,
    });
  });
}

function skusAndProducts(rows: ReturnType<typeof legacyInventoryRows>) {
  return {
    skus: rows.map((row) =>
      doc("skus", {
        _id: row.sku_id as string,
        product_id: `product_${row.sku_id as string}`,
        sku_code: row.skuCode,
        variant_label: row.variantLabel,
        sort_order: 0,
        is_default: true,
        is_active: true,
      }),
    ),
    products: rows.map((row) =>
      doc("products", {
        _id: `product_${row.sku_id as string}`,
        name: row.productName,
        primary_category_id: "cat",
        slug: String(row.productName).toLowerCase().replaceAll(" ", "-"),
        status: "active",
        rating_average: 0,
        rating_count: 0,
        attributes: [],
        created_at: 1,
        updated_at: 1,
      }),
    ),
  };
}

describe("inventory store queries", () => {
  it("uses the store index and hydrates only the returned page", async () => {
    const targetRows = legacyInventoryRows("store_a", 80);
    const otherRows = legacyInventoryRows("store_b", 200);
    const quickRows = Array.from({ length: 50 }, (_, index) =>
      doc("inventory", {
        _id: `quick_${index}`,
        sku: `Q-${index}`,
        productId: `quick_product_${index}`,
        fulfillmentCenterId: "center",
        availableQuantity: 10,
        reservedQuantity: 0,
        replenishmentThreshold: 2,
      }),
    );
    const refs = skusAndProducts(targetRows);
    const db = new FakeConvexDb({
      inventory: [...targetRows, ...otherRows, ...quickRows],
      skus: refs.skus,
      products: refs.products,
    });

    const result = await listByStoreHandler(
      { db },
      { store_id: "store_a" as Id<"stores">, limit: 3, offset: 4 },
    );

    expect(result.total).toBe(80);
    expect(result.data).toHaveLength(3);
    expect(result.data.map((row) => row.product_name)).toEqual([
      "Item 004",
      "Item 005",
      "Item 006",
    ]);
    expect(db.stats.collect["inventory.by_store"]).toBe(1);
    expect(db.stats.collect.inventory).toBeUndefined();
    expect(db.stats.get.skus).toBeUndefined();
    expect(db.stats.get.products).toBeUndefined();
  });

  it("caps missing-summary fallback to the returned page", async () => {
    const targetRows = legacyInventoryRows("store_a", 80).map((row, index) =>
      index < 10
        ? {
            ...row,
            skuCode: undefined,
            variantLabel: undefined,
            productName: undefined,
          }
        : row,
    );
    const refs = skusAndProducts(targetRows);
    const db = new FakeConvexDb({
      inventory: targetRows,
      skus: refs.skus,
      products: refs.products,
    });

    const result = await listByStoreHandler(
      { db },
      { store_id: "store_a" as Id<"stores">, limit: 3 },
    );

    expect(result.data).toHaveLength(3);
    expect(db.stats.get.skus).toBe(3);
    expect(db.stats.get.products).toBe(3);
  });

  it("uses the status index when filtering and keeps summaries store scoped", async () => {
    const targetRows = legacyInventoryRows("store_a", 40);
    const otherRows = legacyInventoryRows("store_b", 40);
    const refs = skusAndProducts(targetRows);
    const db = new FakeConvexDb({
      inventory: [...targetRows, ...otherRows],
      skus: refs.skus,
      products: refs.products,
    });

    const result = await listByStoreHandler(
      { db },
      {
        store_id: "store_a" as Id<"stores">,
        status: "out_of_stock",
        limit: 5,
      },
    );
    const summary = await summaryByStoreHandler(
      { db },
      { store_id: "store_a" as Id<"stores"> },
    );

    expect(result.total).toBe(10);
    expect(result.data.every((row) => row.store_id === "store_a")).toBe(true);
    expect(db.stats.collect["inventory.by_store_status"]).toBe(1);
    expect(summary).toMatchObject({
      total_skus: 40,
      out_of_stock: 10,
      in_stock: 30,
    });
    expect(db.stats.collect["inventory.by_store"]).toBe(1);
  });
});
