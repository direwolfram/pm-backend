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
    productListSummaryVersion: 2,
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

  it("paginates across equal updated_at values and filter combinations", async () => {
    const t = convexTest({ schema, modules });
    const { catA, catB, brandA, brandB } = await t.run(async (ctx) => {
      const catA = await ctx.db.insert("categories", {
        name: "Cat A",
        slug: "cat-a",
        sort_order: 1,
        is_active: true,
      });
      const catB = await ctx.db.insert("categories", {
        name: "Cat B",
        slug: "cat-b",
        sort_order: 2,
        is_active: true,
      });
      const brandA = await ctx.db.insert("brands", {
        name: "Brand A",
        is_active: true,
      });
      const brandB = await ctx.db.insert("brands", {
        name: "Brand B",
        is_active: true,
      });
      const statuses = ["active", "draft", "discontinued"] as const;
      for (let index = 0; index < 12; index += 1) {
        await ctx.db.insert("products", {
          primary_category_id: index % 2 === 0 ? catA : catB,
          brand_id: index % 3 === 0 ? brandA : brandB,
          name: `Combo Product ${index}`,
          slug: `combo-${index}`,
          status: statuses[index % statuses.length],
          rating_average: 0,
          rating_count: 0,
          sku_count: 0,
          total_stock: 0,
          productListSummaryVersion: 2,
          attributes: [],
          created_at: 1,
          updated_at: 5_000, // identical sort key for every row
        });
      }
      return { catA, catB, brandA, brandB };
    });

    // every filter combination, paged with limit 3
    const combos: Record<string, unknown>[] = [
      {},
      { status: "active" },
      { category_id: catA },
      { brand_id: brandA },
      { status: "draft", category_id: catB },
      { status: "discontinued", brand_id: brandB },
      { category_id: catA, brand_id: brandA },
      { status: "active", category_id: catB, brand_id: brandB },
    ];
    for (const combo of combos) {
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const page: any = await t.query(api.products.list, {
          ...combo,
          limit: 3,
          cursor,
        } as any);
        for (const row of page.data as any[]) {
          if (combo.status) expect(row.status).toBe(combo.status);
          if (combo.category_id) {
            expect(row.primary_category_id).toBe(combo.category_id);
          }
          if (combo.brand_id) expect(row.brand_id).toBe(combo.brand_id);
          seen.push(row.slug as string);
        }
        cursor = page.nextCursor;
        pages += 1;
        expect(pages).toBeLessThan(10);
      } while (cursor !== null);
      expect(new Set(seen).size).toBe(seen.length);
    }

    // search continuation over relevance order
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: any = await t.query(api.products.list, {
        search: "Combo",
        limit: 5,
        cursor,
      } as any);
      seen.push(...page.data.map((row: any) => row.slug as string));
      cursor = page.nextCursor;
    } while (cursor !== null);
    expect(seen).toHaveLength(12);
    expect(new Set(seen).size).toBe(12);
  });
});
