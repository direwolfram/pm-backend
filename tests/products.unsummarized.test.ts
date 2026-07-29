import { describe, expect, it } from "vitest";
import { listHandler } from "../convex/products";
import { doc, FakeConvexDb } from "./fakeConvexDb";

describe("products.list unsummarized legacy rows", () => {
  it("never triggers SKU, price, or inventory reads and flags the migration state", async () => {
    const db = new FakeConvexDb({
      products: [
        doc("products", {
          _id: "legacy_a",
          brand_id: "brand_a",
          primary_category_id: "cat_a",
          name: "Legacy Product",
          slug: "legacy-product",
          status: "active",
          rating_average: 0,
          rating_count: 0,
          attributes: [],
          created_at: 1,
          updated_at: 1,
        }),
      ],
      listCounts: [
        doc("listCounts", { _id: "lc_all", scope: "products", key: "all", count: 1 }),
      ],
      brands: [doc("brands", { _id: "brand_a", name: "Brand A", is_active: true })],
      categories: [
        doc("categories", {
          _id: "cat_a",
          name: "Cat A",
          slug: "cat-a",
          sort_order: 1,
          is_active: true,
        }),
      ],
      skus: [
        doc("skus", {
          _id: "sku_legacy",
          product_id: "legacy_a",
          sku_code: "LEG-1",
          variant_label: "V",
          sort_order: 0,
          is_default: true,
          is_active: true,
        }),
      ],
      prices: [
        doc("prices", {
          _id: "price_legacy",
          sku_id: "sku_legacy",
          product_id: "legacy_a",
          currency: "PHP",
          sale_price: 19,
          starts_at: 1,
        }),
      ],
      inventory: [
        doc("inventory", {
          _id: "inv_legacy",
          sku_id: "sku_legacy",
          productId: "legacy_a",
          quantity_available: 7,
          status: "in_stock",
        }),
      ],
    });

    const result = await listHandler({ db }, { limit: 5 });

    // Stored (absent) summary fields are served as-is — no child-table scan.
    expect(result.data[0]).toMatchObject({
      sku_count: 0,
      total_stock: 0,
      default_price: undefined,
    });
    expect(result.summariesPending).toBe(1);
    expect(db.stats.collect.skus).toBeUndefined();
    expect(db.stats.collect.prices).toBeUndefined();
    expect(db.stats.collect.inventory).toBeUndefined();
    expect(db.stats.documentsReturned["skus.by_product"]).toBeUndefined();
    expect(db.stats.documentsReturned["prices.by_sku"]).toBeUndefined();
    expect(db.stats.documentsReturned["inventory.by_product_id"]).toBeUndefined();
    expect(db.stats.documentsReturned["pricesActive.by_sku"]).toBeUndefined();
  });
});
