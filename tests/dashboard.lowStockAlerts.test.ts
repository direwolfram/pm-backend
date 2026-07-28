import { describe, expect, it } from "vitest";
import { lowStockAlertsHandler } from "../convex/dashboard";
import { doc, FakeConvexDb } from "./fakeConvexDb";

function alertRows(status: "low_stock" | "out_of_stock", count: number) {
  return Array.from({ length: count }, (_, index) => {
    const n = String(index).padStart(3, "0");
    return doc("inventory", {
      _id: `${status}_${n}`,
      sku_id: `sku_${status}_${n}`,
      store_id: `store_${index % 4}`,
      quantity_available: status === "out_of_stock" ? index - count : index + 1,
      quantity_reserved: 0,
      low_stock_threshold: 5,
      status,
      updated_at: 1,
      skuCode: `SKU-sku_${status}_${n}`,
      variantLabel: "Default",
      productName: `Product sku_${status}_${n}`,
      storeName: `Store ${index % 4}`,
    });
  });
}

function refs(rows: ReturnType<typeof alertRows>) {
  return {
    skus: rows.map((row) =>
      doc("skus", {
        _id: row.sku_id as string,
        product_id: `product_${row.sku_id as string}`,
        sku_code: `SKU-${row.sku_id as string}`,
        variant_label: "Default",
        sort_order: 0,
        is_default: true,
        is_active: true,
      }),
    ),
    products: rows.map((row) =>
      doc("products", {
        _id: `product_${row.sku_id as string}`,
        name: `Product ${row.sku_id as string}`,
        primary_category_id: "cat",
        slug: `product-${row.sku_id as string}`,
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

describe("dashboard.lowStockAlerts", () => {
  it("uses bounded status indexes and hydrates only returned alerts", async () => {
    const lowStock = alertRows("low_stock", 100);
    const outOfStock = alertRows("out_of_stock", 100);
    const inStock = Array.from({ length: 500 }, (_, index) =>
      doc("inventory", {
        _id: `in_stock_${index}`,
        sku_id: `sku_in_${index}`,
        store_id: "store_irrelevant",
        quantity_available: 100,
        quantity_reserved: 0,
        low_stock_threshold: 5,
        status: "in_stock",
        updated_at: 1,
      }),
    );
    const referenced = [...lowStock.slice(0, 8), ...outOfStock.slice(0, 8)];
    const related = refs(referenced);
    const db = new FakeConvexDb({
      inventory: [...outOfStock, ...lowStock, ...inStock],
      skus: related.skus,
      products: related.products,
      stores: Array.from({ length: 4 }, (_, index) =>
        doc("stores", {
          _id: `store_${index}`,
          name: `Store ${index}`,
          status: "active",
          address: "A",
          latitude: 0,
          longitude: 0,
          timezone: "UTC",
          created_at: 1,
          updated_at: 1,
        }),
      ),
    });

    const result = await lowStockAlertsHandler({ db }, { limit: 8 });

    expect(result).toHaveLength(8);
    expect(result.map((row) => row.quantity_available)).toEqual([
      -100,
      -99,
      -98,
      -97,
      -96,
      -95,
      -94,
      -93,
    ]);
    expect(db.stats.collect["inventory.by_status_quantity"]).toBe(2);
    expect(db.stats.documentsReturned["inventory.by_status_quantity"]).toBe(16);
    expect(db.stats.collect.inventory).toBeUndefined();
    expect(db.stats.collect.order_items).toBeUndefined();
    expect(db.stats.get.skus).toBeUndefined();
    expect(db.stats.get.products).toBeUndefined();
    expect(db.stats.get.stores).toBeUndefined();
  });
});
