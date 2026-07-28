import { describe, expect, it } from "vitest";
import type { Id } from "../convex/_generated/dataModel";
import { getHandler } from "../convex/products";
import { doc, FakeConvexDb } from "./fakeConvexDb";

function product(id: string, name: string) {
  return doc("products", {
    _id: id,
    name,
    primary_category_id: "cat_a",
    slug: name.toLowerCase().replaceAll(" ", "-"),
    status: "active",
    rating_average: 0,
    rating_count: 0,
    attributes: [],
    created_at: 1,
    updated_at: 1,
  });
}

describe("products.get read scaling", () => {
  it("caps and deduplicates similar-product direct reads", async () => {
    const similarProducts = Array.from({ length: 40 }, (_, index) =>
      product(`similar_${index}`, `Similar ${index}`),
    );
    const duplicatePairs = Array.from({ length: 10 }, (_, index) =>
      doc("product_similar_products", {
        _id: `dup_${index}`,
        product_id: "product_a",
        similar_product_id: "similar_0",
      }),
    );
    const db = new FakeConvexDb({
      products: [product("product_a", "Product A"), ...similarProducts],
      product_media: [],
      product_similar_products: [
        ...similarProducts.map((item, index) =>
          doc("product_similar_products", {
            _id: `pair_${index}`,
            product_id: "product_a",
            similar_product_id: item._id,
          }),
        ),
        ...duplicatePairs,
      ],
      skus: [],
      categories: [
        doc("categories", {
          _id: "cat_a",
          name: "Category A",
          slug: "category-a",
          sort_order: 0,
          is_active: true,
        }),
      ],
    });

    const result = await getHandler(
      { db, storage: { getUrl: async () => null } },
      { id: "product_a" as Id<"products"> },
    );

    expect(result.similar).toHaveLength(24);
    expect(db.stats.collect["product_similar_products.by_product"]).toBe(1);
    expect(db.stats.get.products).toBe(25);
  });
});
