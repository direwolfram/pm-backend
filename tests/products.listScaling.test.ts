import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import { api } from "../convex/_generated/api";
import schema from "../convex/schema";
import type { Id } from "../convex/_generated/dataModel";
import { listHandler } from "../convex/products";
import { doc, FakeConvexDb } from "./fakeConvexDb";

const modules = import.meta.glob("../convex/**/*.ts");

function product(id: string, categoryId: string, brandId: string, updatedAt: number) {
  return doc("products", {
    _id: id,
    brand_id: brandId,
    primary_category_id: categoryId,
    name: `Product ${id}`,
    slug: id,
    status: "active",
    rating_average: 0,
    rating_count: 0,
    sku_count: 2,
    default_sku_id: `sku_${id}`,
    default_price: 42,
    total_stock: 12,
    productListSummaryVersion: 1,
    attributes: [],
    created_at: 1,
    updated_at: updatedAt,
  });
}

describe("products.list read scaling", () => {
  it("pages products before enrichment and does not read SKU, price, or inventory tables when summaries exist", async () => {
    const target = Array.from({ length: 30 }, (_, index) =>
      product(`target_${index}`, "cat_a", "brand_a", 10_000 - index),
    );
    const unrelated = Array.from({ length: 400 }, (_, index) =>
      product(`other_${index}`, "cat_b", "brand_b", index),
    );
    const db = new FakeConvexDb({
      products: [...target, ...unrelated],
      categories: [
        doc("categories", {
          _id: "cat_a",
          name: "Category A",
          slug: "category-a",
          sort_order: 1,
          is_active: true,
        }),
      ],
      brands: [
        doc("brands", {
          _id: "brand_a",
          name: "Brand A",
          is_active: true,
        }),
      ],
      skus: [],
      prices: [],
      inventory: [],
    });

    const result = await listHandler(
      { db },
      {
        category_id: "cat_a" as Id<"categories">,
        brand_id: "brand_a" as Id<"brands">,
        status: "active",
        limit: 5,
      },
    );

    expect(result.data).toHaveLength(5);
    expect(result.data[0]).toMatchObject({
      sku_count: 2,
      default_price: 42,
      total_stock: 12,
      brand_name: "Brand A",
      category_name: "Category A",
    });
    expect(db.stats.collect["products.by_category_brand_status_updated"]).toBe(1);
    expect(db.stats.collect.products).toBeUndefined();
    expect(db.stats.collect.skus).toBeUndefined();
    expect(db.stats.collect.prices).toBeUndefined();
    expect(db.stats.collect.inventory).toBeUndefined();
    expect(db.stats.get.brands).toBe(1);
    expect(db.stats.get.categories).toBe(1);
  });
});

describe("products.list query behavior", () => {
  it("does not patch unsummarized legacy products from a query", async () => {
    const t = convexTest({ schema, modules });
    const productId = await t.run(async (ctx) => {
      const categoryId = await ctx.db.insert("categories", {
        name: "Category",
        slug: "category",
        sort_order: 1,
        is_active: true,
      });
      return await ctx.db.insert("products", {
        primary_category_id: categoryId,
        name: "Legacy Product",
        slug: "legacy-product",
        status: "active",
        rating_average: 0,
        rating_count: 0,
        attributes: [],
        created_at: 1,
        updated_at: 1,
      });
    });

    const result = await t.query(api.products.list, { limit: 1 });
    const product = await t.run(async (ctx) => await ctx.db.get(productId));

    expect(result.data[0].name).toBe("Legacy Product");
    expect(product?.productListSummaryVersion).toBeUndefined();
  });
});
