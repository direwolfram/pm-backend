import { describe, expect, it } from "vitest";
import { listBySkuHandler } from "../convex/prices";
import { listByProductHandler } from "../convex/skus";
import { doc, FakeConvexDb } from "./fakeConvexDb";

function skuRows(count: number) {
  return Array.from({ length: count }, (_, index) =>
    doc("skus", {
      _id: `sku_${index}`,
      product_id: "product_a",
      sku_code: `SKU-${index}`,
      variant_label: `Variant ${index}`,
      sort_order: index,
      is_default: index === 0,
      is_active: true,
    }),
  );
}

describe("SKU and price read scaling", () => {
  it("lists product SKUs without price and inventory queries per SKU", async () => {
    const skus = skuRows(80);
    const db = new FakeConvexDb({
      skus,
      prices: skus.flatMap((sku, index) => [
        doc("prices", {
          _id: `price_${index}_a`,
          sku_id: sku._id,
          product_id: "product_a",
          currency: "PHP",
          sale_price: 10 + index,
          starts_at: 1,
        }),
        doc("prices", {
          _id: `price_${index}_b`,
          sku_id: sku._id,
          product_id: "product_a",
          currency: "PHP",
          sale_price: 20 + index,
          starts_at: 2,
        }),
      ]),
      inventory: skus.map((sku, index) =>
        doc("inventory", {
          _id: `inventory_${index}`,
          sku_id: sku._id,
          productId: "product_a",
          store_id: "store_a",
          quantity_available: index,
          quantity_reserved: 0,
          low_stock_threshold: 5,
          status: "in_stock",
          updated_at: 1,
        }),
      ),
    });

    const result = await listByProductHandler(
      { db },
      { product_id: "product_a" },
    );

    expect(result).toHaveLength(80);
    expect(result[0].prices).toHaveLength(2);
    expect(result[0].inventory).toHaveLength(1);
    expect(db.stats.collect["skus.by_product"]).toBe(1);
    expect(db.stats.collect["prices.by_product"]).toBe(1);
    expect(db.stats.collect["inventory.by_product_id"]).toBe(1);
    expect(db.stats.collect["prices.by_sku"]).toBeUndefined();
    expect(db.stats.collect["inventory.by_sku"]).toBeUndefined();
  });

  it("deduplicates repeated store fallback reads in price history", async () => {
    const db = new FakeConvexDb({
      prices: Array.from({ length: 50 }, (_, index) =>
        doc("prices", {
          _id: `price_${index}`,
          sku_id: "sku_a",
          product_id: "product_a",
          store_id: "store_a",
          currency: "PHP",
          sale_price: 10 + index,
          starts_at: index,
        }),
      ),
      stores: [
        doc("stores", {
          _id: "store_a",
          name: "Store A",
          status: "active",
          address: "A",
          latitude: 0,
          longitude: 0,
          timezone: "UTC",
          created_at: 1,
          updated_at: 1,
        }),
      ],
    });

    const result = await listBySkuHandler({ db }, { sku_id: "sku_a" });

    expect(result).toHaveLength(50);
    expect(result.every((price) => price.store_name === "Store A")).toBe(true);
    expect(db.stats.collect["prices.by_sku"]).toBe(1);
    expect(db.stats.get.stores).toBe(1);
  });

  it("uses stored price store names without store fallback reads", async () => {
    const db = new FakeConvexDb({
      prices: Array.from({ length: 50 }, (_, index) =>
        doc("prices", {
          _id: `price_${index}`,
          sku_id: "sku_a",
          product_id: "product_a",
          store_id: "store_a",
          storeName: "Store A",
          currency: "PHP",
          sale_price: 10 + index,
          starts_at: index,
        }),
      ),
    });

    await listBySkuHandler({ db }, { sku_id: "sku_a" });

    expect(db.stats.get.stores).toBeUndefined();
  });
});
