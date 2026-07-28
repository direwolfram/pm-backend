import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import { api } from "../convex/_generated/api";
import schema from "../convex/schema";
import type { Id } from "../convex/_generated/dataModel";

const modules = import.meta.glob("../convex/**/*.ts");

async function seedBase(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const categoryId = await ctx.db.insert("categories", {
      name: "Cat",
      slug: "cat",
      sort_order: 1,
      is_active: true,
    });
    const brandId = await ctx.db.insert("brands", {
      name: "Brand",
      is_active: true,
    });
    const storeId = await ctx.db.insert("stores", {
      name: "Store",
      status: "active",
      address: "A",
      latitude: 0,
      longitude: 0,
      timezone: "Asia/Manila",
      created_at: 1,
      updated_at: 1,
    });
    const productId = await ctx.db.insert("products", {
      primary_category_id: categoryId,
      brand_id: brandId,
      name: "Cascade Product",
      slug: "cascade-product",
      status: "active",
      rating_average: 0,
      rating_count: 0,
      sku_count: 0,
      total_stock: 0,
      productListSummaryVersion: 2,
      attributes: [],
      created_at: 1,
      updated_at: 1,
    });
    const sectionId = await ctx.db.insert("home_sections", {
      kind: "spacer",
      tab: "All",
    });
    const promoId = await ctx.db.insert("promotions", {
      kind: "banner",
      title: "Promo",
      currency: "PHP",
      starts_at: 1,
      ends_at: 2,
      is_active: true,
    });
    return { categoryId, brandId, storeId, productId, sectionId, promoId };
  });
}

async function countRows(
  t: ReturnType<typeof convexTest>,
  table: "product_media" | "product_similar_products" | "prices" | "inventory" | "skus" | "home_section_items" | "promotion_targets" | "delivery_zones" | "categories" | "products",
) {
  return await t.run(async (ctx) => (await ctx.db.query(table).collect()).length);
}

describe("bounded cascade workflows", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("deletes a product with more than 100 dependents per phase", async () => {
    const t = convexTest({ schema, modules });
    const { productId, sectionId, promoId } = await seedBase(t);
    await t.run(async (ctx) => {
      for (let index = 0; index < 120; index += 1) {
        await ctx.db.insert("product_media", {
          product_id: productId,
          url: `https://x/${index}`,
          sort_order: index,
        });
        await ctx.db.insert("product_similar_products", {
          product_id: productId,
          similar_product_id: productId,
        });
        await ctx.db.insert("home_section_items", {
          section_id: sectionId,
          product_id: productId,
          sort_order: index,
        });
        await ctx.db.insert("promotion_targets", {
          promotion_id: promoId,
          product_id: productId,
        });
      }
      for (let index = 0; index < 130; index += 1) {
        const skuId = await ctx.db.insert("skus", {
          product_id: productId,
          sku_code: `CASCADE-${index}`,
          variant_label: "V",
          sort_order: index,
          is_default: index === 0,
          is_active: true,
        });
        await ctx.db.insert("prices", {
          sku_id: skuId,
          product_id: productId,
          currency: "PHP",
          sale_price: 1,
          starts_at: 1,
        });
        await ctx.db.insert("inventory", {
          sku_id: skuId,
          productId,
          quantity_available: 1,
        });
      }
    });

    const accepted = await t.mutation(api.products.remove, { id: productId });
    expect(accepted).toMatchObject({ deleting: true });
    // duplicate delete request is idempotent
    await t.mutation(api.products.remove, { id: productId });

    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(await countRows(t, "product_media")).toBe(0);
    expect(await countRows(t, "product_similar_products")).toBe(0);
    expect(await countRows(t, "skus")).toBe(0);
    expect(await countRows(t, "prices")).toBe(0);
    expect(await countRows(t, "inventory")).toBe(0);
    expect(await countRows(t, "home_section_items")).toBe(0);
    expect(await countRows(t, "promotion_targets")).toBe(0);
    await expect(
      t.run(async (ctx) => await ctx.db.get(productId)),
    ).resolves.toBeNull();
  });

  it("rejects new references while a product is deleting", async () => {
    const t = convexTest({ schema, modules });
    const { productId } = await seedBase(t);
    await t.mutation(api.products.remove, { id: productId });

    await expect(
      t.mutation(api.skus.create, {
        product_id: productId,
        sku_code: "LATE-1",
        variant_label: "V",
      }),
    ).rejects.toThrow(/being deleted/);
    await expect(
      t.mutation(api.products.addMedia, {
        product_id: productId,
        url: "https://x/late",
      }),
    ).rejects.toThrow(/being deleted/);
    await expect(
      t.mutation(api.products.setSimilar, {
        product_id: productId,
        similar_product_ids: [],
      }),
    ).rejects.toThrow(/being deleted/);

    await t.finishAllScheduledFunctions(vi.runAllTimers);
  });

  it("deletes a SKU with more than 100 prices and inventory rows", async () => {
    const t = convexTest({ schema, modules });
    const { productId } = await seedBase(t);
    const skuId = await t.run(async (ctx) => {
      const skuId = await ctx.db.insert("skus", {
        product_id: productId,
        sku_code: "BIG-SKU",
        variant_label: "V",
        sort_order: 0,
        is_default: false,
        is_active: true,
      });
      for (let index = 0; index < 110; index += 1) {
        await ctx.db.insert("prices", {
          sku_id: skuId,
          product_id: productId,
          currency: "PHP",
          sale_price: 1,
          starts_at: index,
          ends_at: index + 1,
        });
        await ctx.db.insert("inventory", {
          sku_id: skuId,
          productId,
          quantity_available: 1,
        });
      }
      return skuId;
    });

    await t.mutation(api.skus.remove, { id: skuId });
    // duplicate continuation scheduling is safe
    await t.mutation(api.skus.remove, { id: skuId });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(await countRows(t, "prices")).toBe(0);
    expect(await countRows(t, "inventory")).toBe(0);
    expect(await countRows(t, "skus")).toBe(0);
  });

  it("rejects prices and inventory for a deleting SKU", async () => {
    const t = convexTest({ schema, modules });
    const { productId, storeId } = await seedBase(t);
    const skuId = await t.run(async (ctx) =>
      ctx.db.insert("skus", {
        product_id: productId,
        sku_code: "DYING-SKU",
        variant_label: "V",
        sort_order: 0,
        is_default: false,
        is_active: true,
      }),
    );
    await t.mutation(api.skus.remove, { id: skuId });

    await expect(
      t.mutation(api.prices.upsert, { sku_id: skuId, sale_price: 1 }),
    ).rejects.toThrow(/being deleted/);
    await expect(
      t.mutation(api.inventory.upsert, {
        sku_id: skuId,
        store_id: storeId,
        quantity_available: 1,
      }),
    ).rejects.toThrow(/being deleted/);

    await t.finishAllScheduledFunctions(vi.runAllTimers);
  });

  it("sets category children parent to null across more than 100 children", async () => {
    const t = convexTest({ schema, modules });
    const { sectionId, promoId } = await seedBase(t);
    const categoryId = await t.run(async (ctx) =>
      ctx.db.insert("categories", {
        name: "Empty Parent",
        slug: "empty-parent",
        sort_order: 1,
        is_active: true,
      }),
    );
    await t.run(async (ctx) => {
      for (let index = 0; index < 115; index += 1) {
        await ctx.db.insert("categories", {
          parent_id: categoryId,
          name: `Child ${index}`,
          slug: `child-${index}`,
          sort_order: index,
          is_active: true,
        });
        await ctx.db.insert("home_section_items", {
          section_id: sectionId,
          category_id: categoryId,
          sort_order: index,
        });
        await ctx.db.insert("promotion_targets", {
          promotion_id: promoId,
          category_id: categoryId,
        });
      }
    });

    await t.mutation(api.categories.remove, { id: categoryId });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const orphans = await t.run(async (ctx) =>
      ctx.db.query("categories").collect(),
    );
    // 115 orphaned children + the seeded "Cat" category
    expect(orphans).toHaveLength(116);
    expect(orphans.every((c) => c.parent_id === undefined)).toBe(true);
    expect(await countRows(t, "home_section_items")).toBe(0);
    expect(await countRows(t, "promotion_targets")).toBe(0);
    await expect(
      t.run(async (ctx) => await ctx.db.get(categoryId)),
    ).resolves.toBeNull();
  });

  it("restricts category deletion while products reference it", async () => {
    const t = convexTest({ schema, modules });
    const { categoryId } = await seedBase(t);
    await expect(
      t.mutation(api.categories.remove, { id: categoryId }),
    ).rejects.toThrow(/products use this category/);
    await expect(
      t.run(async (ctx) => await ctx.db.get(categoryId)),
    ).resolves.toMatchObject({ name: "Cat" });
  });

  it("sets products brand_id to null across more than 100 products", async () => {
    const t = convexTest({ schema, modules });
    const { categoryId, brandId, promoId } = await seedBase(t);
    await t.run(async (ctx) => {
      for (let index = 0; index < 105; index += 1) {
        await ctx.db.insert("products", {
          primary_category_id: categoryId,
          brand_id: brandId,
          name: `Brand Product ${index}`,
          slug: `brand-product-${index}`,
          status: "active",
          rating_average: 0,
          rating_count: 0,
          attributes: [],
          created_at: 1,
          updated_at: 1,
        });
        await ctx.db.insert("promotion_targets", {
          promotion_id: promoId,
          brand_id: brandId,
        });
      }
    });

    await t.mutation(api.brands.remove, { id: brandId });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const products = await t.run(async (ctx) =>
      ctx.db.query("products").collect(),
    );
    const branded = products.filter((p) => p.brand_id !== undefined);
    expect(branded).toHaveLength(0);
    expect(await countRows(t, "promotion_targets")).toBe(0);
    await expect(
      t.run(async (ctx) => await ctx.db.get(brandId)),
    ).resolves.toBeNull();
  });

  it("deletes a promotion with more than 100 targets and home items", async () => {
    const t = convexTest({ schema, modules });
    const { productId, sectionId } = await seedBase(t);
    const promotionId = await t.run(async (ctx) => {
      const promotionId = await ctx.db.insert("promotions", {
        kind: "banner",
        title: "Big Promo",
        currency: "PHP",
        starts_at: 1,
        ends_at: 2,
        is_active: true,
      });
      for (let index = 0; index < 110; index += 1) {
        await ctx.db.insert("promotion_targets", {
          promotion_id: promotionId,
          product_id: productId,
        });
        await ctx.db.insert("home_section_items", {
          section_id: sectionId,
          promotion_id: promotionId,
          sort_order: index,
        });
      }
      return promotionId;
    });

    await t.mutation(api.promotions.remove, { id: promotionId });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(await countRows(t, "promotion_targets")).toBe(0);
    expect(await countRows(t, "home_section_items")).toBe(0);
    await expect(
      t.run(async (ctx) => await ctx.db.get(promotionId)),
    ).resolves.toBeNull();
  });

  it("deletes a store with more than 100 zones, inventory rows, and prices", async () => {
    const t = convexTest({ schema, modules });
    const { productId, storeId } = await seedBase(t);
    await t.run(async (ctx) => {
      const skuId = await ctx.db.insert("skus", {
        product_id: productId,
        sku_code: "STORE-SKU",
        variant_label: "V",
        sort_order: 0,
        is_default: true,
        is_active: true,
      });
      for (let index = 0; index < 110; index += 1) {
        await ctx.db.insert("delivery_zones", {
          store_id: storeId,
          name: `Zone ${index}`,
          delivery_mode: "express",
          min_order_amount: 0,
          delivery_fee_amount: 0,
          currency: "PHP",
          estimated_minutes_min: 1,
          estimated_minutes_max: 2,
          is_active: true,
        });
        await ctx.db.insert("inventory", {
          sku_id: skuId,
          store_id: storeId,
          quantity_available: 1,
        });
        await ctx.db.insert("prices", {
          sku_id: skuId,
          store_id: storeId,
          currency: "PHP",
          sale_price: 1,
          starts_at: index,
          ends_at: index + 1,
        });
      }
    });

    await t.mutation(api.stores.remove, { id: storeId });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(await countRows(t, "delivery_zones")).toBe(0);
    expect(await countRows(t, "inventory")).toBe(0);
    expect(await countRows(t, "prices")).toBe(0);
    await expect(
      t.run(async (ctx) => await ctx.db.get(storeId)),
    ).resolves.toBeNull();
  });

  it("restricts store deletion while orders reference it", async () => {
    const t = convexTest({ schema, modules });
    const { storeId } = await seedBase(t);
    await t.run(async (ctx) => {
      const customerId = await ctx.db.insert("customers", {
        phone_country_code: "+63",
        phone_number: "1",
        status: "active",
        marketing_opt_in: false,
        created_at: 1,
        updated_at: 1,
      });
      const addressId = await ctx.db.insert("addresses", {
        customer_id: customerId,
        label: "home",
        title: "H",
        full_address: "H",
        country_code: "PH",
        latitude: 0,
        longitude: 0,
        is_default: true,
        created_at: 1,
        updated_at: 1,
      });
      await ctx.db.insert("orders", {
        order_number: "PM-STORE-1",
        customer_id: customerId,
        store_id: storeId,
        address_id: addressId,
        delivery_mode: "express",
        status: "confirmed",
        payment_status: "paid",
        currency: "PHP",
        subtotal_amount: 1,
        discount_amount: 0,
        delivery_fee_amount: 0,
        total_amount: 1,
        placed_at: 1,
      });
    });

    await expect(
      t.mutation(api.stores.remove, { id: storeId }),
    ).rejects.toThrow(/has orders/);
  });

  it("rejects references to deleting brands, categories, and stores", async () => {
    const t = convexTest({ schema, modules });
    const { categoryId, brandId, storeId } = await seedBase(t);
    await t.mutation(api.brands.remove, { id: brandId });
    await t.mutation(api.stores.remove, { id: storeId });

    await expect(
      t.mutation(api.products.create, {
        primary_category_id: categoryId,
        brand_id: brandId,
        name: "Late Product",
      }),
    ).rejects.toThrow(/being deleted/);
    await expect(
      t.mutation(api.stores.createZone, {
        store_id: storeId,
        name: "Late Zone",
        delivery_mode: "express",
        estimated_minutes_min: 1,
        estimated_minutes_max: 2,
      }),
    ).rejects.toThrow(/being deleted/);
    await expect(
      t.mutation(api.promotions.create, {
        kind: "banner",
        title: "Late Target",
        starts_at: 1,
        ends_at: 2,
        targets: [{ brand_id: brandId }],
      }),
    ).rejects.toThrow(/being deleted/);

    await t.finishAllScheduledFunctions(vi.runAllTimers);

    // a category that is being deleted rejects new children/products
    const parentId = await t.run(async (ctx) =>
      ctx.db.insert("categories", {
        name: "Dying Parent",
        slug: "dying-parent",
        sort_order: 1,
        is_active: true,
      }),
    );
    await t.mutation(api.categories.remove, { id: parentId });
    await expect(
      t.mutation(api.products.create, {
        primary_category_id: parentId,
        name: "Late Product 2",
      }),
    ).rejects.toThrow(/being deleted/);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    void categoryId;
  });

  it("caps similar-product replacement and applies bounded diffs", async () => {
    const t = convexTest({ schema, modules });
    const { productId, categoryId } = await seedBase(t);
    const others = await t.run(async (ctx) => {
      const ids: Id<"products">[] = [];
      for (let index = 0; index < 30; index += 1) {
        ids.push(
          await ctx.db.insert("products", {
            primary_category_id: categoryId,
            name: `Other ${index}`,
            slug: `other-${index}`,
            status: "active",
            rating_average: 0,
            rating_count: 0,
            attributes: [],
            created_at: 1,
            updated_at: 1,
          }),
        );
      }
      return ids;
    });

    await expect(
      t.mutation(api.products.setSimilar, {
        product_id: productId,
        similar_product_ids: others.slice(0, 25),
      }),
    ).rejects.toThrow(/at most 24/);

    await t.mutation(api.products.setSimilar, {
      product_id: productId,
      similar_product_ids: others.slice(0, 24),
    });
    expect(await countRows(t, "product_similar_products")).toBe(24);

    // replacement deletes stale pairs and keeps shared ones
    await t.mutation(api.products.setSimilar, {
      product_id: productId,
      similar_product_ids: others.slice(12, 24),
    });
    expect(await countRows(t, "product_similar_products")).toBe(12);
  });
});
